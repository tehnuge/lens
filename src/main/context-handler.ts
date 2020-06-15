import { KubeConfig, CoreV1Api } from "@kubernetes/client-node"
import { readFileSync } from "fs"
import * as http from "http"
import { ServerOptions } from "http-proxy"
import * as url from "url"
import logger from "./logger"
import { getFreePort } from "./port"
import { KubeAuthProxy } from "./kube-auth-proxy"
import { Cluster, ClusterPreferences } from "./cluster"
import { prometheusProviders } from "../common/prometheus-providers"
import { PrometheusService, PrometheusProvider } from "./prometheus/provider-registry"
import { PrometheusLens } from "./prometheus/lens"
import { KubeconfigManager } from "./kubeconfig-manager"

export class ContextHandler {
  public contextName: string
  public id: string
  public url: string
  public kc: KubeConfig
  public certData: string
  public authCertData: string
  public cluster: Cluster

  protected apiTarget: ServerOptions
  protected proxyTarget: ServerOptions
  public clusterUrl: url.UrlWithStringQuery
  public proxyServer: KubeAuthProxy

  protected clientCert: string
  protected clientKey: string
  protected secureApiConnection = true
  protected defaultNamespace: string
  public proxyPort: number
  protected kubernetesApi: string
  protected prometheusProvider: string
  protected prometheusPath: string
  protected clusterName: string

  constructor(kc: KubeConfig, cluster: Cluster) {
    this.id = cluster.id
    this.kc = kc
    this.kc.setCurrentContext(cluster.contextName)

    this.cluster = cluster
    this.clusterUrl = url.parse(kc.getCurrentCluster().server)
    this.contextName = cluster.contextName;
    this.defaultNamespace = kc.getContextObject(kc.currentContext).namespace
    this.url = `http://${this.id}.localhost:${cluster.port}/`
    this.kubernetesApi = `http://127.0.0.1:${cluster.port}/${this.id}`

    this.setClusterPreferences(cluster.preferences)
  }

  public async init() {
    await this.resolveProxyPort()
  }

  public setClusterPreferences(clusterPreferences?: ClusterPreferences) {
    this.prometheusProvider = clusterPreferences.prometheusProvider?.type

    if (clusterPreferences && clusterPreferences.prometheus) {
      const prom = clusterPreferences.prometheus
      this.prometheusPath = `${prom.namespace}/services/${prom.service}:${prom.port}`
    } else {
      this.prometheusPath = null
    }
    if(clusterPreferences && clusterPreferences.clusterName) {
      this.clusterName = clusterPreferences.clusterName;
    } else {
      this.clusterName = this.contextName;
    }
  }

  protected async resolvePrometheusPath(): Promise<string> {
    const service = await this.getPrometheusService()
    return `${service.namespace}/services/${service.service}:${service.port}`
  }

  public async getPrometheusProvider() {
    if (!this.prometheusProvider) {
      const service = await this.getPrometheusService()
      logger.info(`using ${service.id} as prometheus provider`)
      this.prometheusProvider = service.id
    }
    return prometheusProviders.find(p => p.id === this.prometheusProvider)
  }

  public async getPrometheusService(): Promise<PrometheusService> {
    const providers = this.prometheusProvider ? prometheusProviders.filter((p, _) => p.id == this.prometheusProvider) : prometheusProviders
    const prometheusPromises: Promise<PrometheusService>[] = providers.map(async (provider: PrometheusProvider): Promise<PrometheusService> => {
      const apiClient = this.kc.makeApiClient(CoreV1Api)
      return await provider.getPrometheusService(apiClient)
    })
    const resolvedPrometheusServices = await Promise.all(prometheusPromises)
    const service = resolvedPrometheusServices.filter(n => n)[0]
    if (service) {
      return service
    } else {
      return {
        id: "lens",
        namespace: "lens-metrics",
        service: "prometheus",
        port: 80
      }
    }
  }

  public async getPrometheusPath(): Promise<string> {
    if (this.prometheusPath) return this.prometheusPath

    this.prometheusPath = await this.resolvePrometheusPath()

    return this.prometheusPath
  }

  public async getApiTarget(isWatchRequest = false) {
    if (this.apiTarget && !isWatchRequest) {
      return this.apiTarget
    }
    const timeout = isWatchRequest ? 4 * 60 * 60 * 1000 : 30000 // 4 hours for watch request, 30 seconds for the rest
    const apiTarget = await this.newApiTarget(timeout)
    if (!isWatchRequest) {
      this.apiTarget = apiTarget
    }
    return apiTarget
  }

  protected async newApiTarget(timeout: number) {
    return {
      changeOrigin: true,
      timeout: timeout,
      headers: {
        "Host": this.clusterUrl.hostname
      },
      target: {
        port: await this.resolveProxyPort(),
        protocol: "http://",
        host: "localhost",
        path: this.clusterUrl.path
      },
    }
  }

  protected async resolveProxyPort(): Promise<number> {
    if (this.proxyPort) return this.proxyPort

    let serverPort: number = null
    try {
      serverPort = await getFreePort()
    } catch(error) {
      logger.error(error)
      throw(error)
    }
    this.proxyPort = serverPort

    return serverPort
  }

  public applyHeaders(req: http.IncomingMessage) {
    req.headers["authorization"] = `Bearer ${this.id}`
  }

  public async withTemporaryKubeconfig(callback: (kubeconfig: string) => Promise<any>) {
    try {
      await callback(this.cluster.proxyKubeconfigPath())
    } catch(error) {
      throw(error)
    }
  }

  public async ensureServer() {
    if (!this.proxyServer) {
      const proxyPort = await this.resolveProxyPort()
      const proxyEnv = Object.assign({}, process.env)
      if (this.cluster.preferences && this.cluster.preferences.httpsProxy) {
        proxyEnv.HTTPS_PROXY = this.cluster.preferences.httpsProxy
      }
      this.proxyServer = new KubeAuthProxy(this.cluster, proxyPort, proxyEnv)
      await this.proxyServer.run()
    }
  }

  public stopServer() {
    if (this.proxyServer) {
      this.proxyServer.exit()
      this.proxyServer = null
    }
  }

  public proxyServerError() {
    if (!this.proxyServer) { return null }

    return this.proxyServer.lastError
  }
}

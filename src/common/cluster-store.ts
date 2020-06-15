import { app, remote } from "electron"
import * as ElectronStore from "electron-store"
import  { ensureDirSync, writeFileSync } from "fs-extra"
import { Cluster, ClusterBaseInfo } from "../main/cluster";
import { getAppVersion } from "./app-utils"
import * as path from "path"

import * as version200Beta2 from "./migrations/cluster-store/2.0.0-beta.2"
import * as version241 from "./migrations/cluster-store/2.4.1"
import * as version260Beta2 from "./migrations/cluster-store/2.6.0-beta.2"
import * as version260Beta3 from "./migrations/cluster-store/2.6.0-beta.3"
import * as version270Beta0 from "./migrations/cluster-store/2.7.0-beta.0"
import * as version270Beta1 from "./migrations/cluster-store/2.7.0-beta.1"
import * as version350Beta1 from "./migrations/cluster-store/3.5.0-beta.1"

export class ClusterStore {
  private static instance: ClusterStore;
  public store: ElectronStore;

  private constructor() {
    this.store = new ElectronStore({
      name: "lens-cluster-store",
      projectVersion: getAppVersion(),
      accessPropertiesByDotNotation: false, // To make dots safe in cluster context names
      migrations: {
        "2.0.0-beta.2": version200Beta2.migration,
        "2.4.1": version241.migration,
        "2.6.0-beta.2": version260Beta2.migration,
        "2.6.0-beta.3": version260Beta3.migration,
        "2.7.0-beta.0": version270Beta0.migration,
        "2.7.0-beta.1": version270Beta1.migration,
        "3.5.0-beta.1": version350Beta1.migration
      }
    })
  }

  public getAllClusterObjects(): Array<Cluster> {
    return this.store.get("clusters", []).map((clusterInfo: ClusterBaseInfo) => {
      return new Cluster(clusterInfo)
    })
  }

  public getAllClusters(): Array<ClusterBaseInfo> {
    return this.store.get("clusters", [])
  }

  public removeCluster(id: string): void {
    this.store.delete(id);
    const clusterBaseInfos = this.getAllClusters()
    const index = clusterBaseInfos.findIndex((cbi) => cbi.id === id)
    if (index !== -1) {
      clusterBaseInfos.splice(index, 1)
      this.store.set("clusters", clusterBaseInfos)
    }
  }

  public removeClustersByWorkspace(workspace: string) {
    this.getAllClusters().forEach((cluster) => {
      if (cluster.workspace === workspace) {
        this.removeCluster(cluster.id)
      }
    })
  }

  public getCluster(id: string): Cluster {
    const cluster = this.getAllClusterObjects().find((cluster) => cluster.id === id)
    if (cluster) { return cluster}

    return null
  }

  public storeCluster(cluster: ClusterBaseInfo) {
    const clusters = this.getAllClusters();
    const index = clusters.findIndex((cl) => cl.id === cluster.id)
    const storable = {
      id: cluster.id,
      kubeConfigPath: cluster.kubeConfigPath,
      contextName: cluster.contextName,
      preferences: cluster.preferences,
      workspace: cluster.workspace
    }
    if (index === -1) {
      clusters.push(storable)
    } else {
      clusters[index] = storable
    }
    this.store.set("clusters", clusters)
  }

  public storeClusters(clusters: ClusterBaseInfo[]) {
    clusters.forEach((cluster: ClusterBaseInfo) => {
      this.removeCluster(cluster.id)
      this.storeCluster(cluster)
    })
  }

  public reloadCluster(cluster: ClusterBaseInfo): void {
    const storedCluster = this.getCluster(cluster.id);
    if (storedCluster) {
      cluster.kubeConfigPath = storedCluster.kubeConfigPath
      cluster.contextName = storedCluster.contextName
      cluster.preferences = storedCluster.preferences
      cluster.workspace = storedCluster.workspace
    }
  }

  static getInstance(): ClusterStore {
    if(!ClusterStore.instance) {
      ClusterStore.instance = new ClusterStore();
    }
    return ClusterStore.instance;
  }

  static resetInstance() {
    ClusterStore.instance = null
  }
}

const clusterStore: ClusterStore = ClusterStore.getInstance();

export { clusterStore };

// Writes kubeconfigs to "embedded" store, i.e. .../Lens/kubeconfigs/
export function writeEmbeddedKubeConfig(clusterId: string, kubeConfig: string): string {
  // This can be called from main & renderer
  const a = (app || remote.app)
  const kubeConfigBase = path.join(a.getPath("userData"), "kubeconfigs")
  ensureDirSync(kubeConfigBase)

  const kubeConfigFile = path.join(kubeConfigBase, clusterId)
  writeFileSync(kubeConfigFile, kubeConfig)

  return kubeConfigFile
}
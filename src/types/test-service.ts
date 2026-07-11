export type TestServiceType = "redis" | "postgres";

export interface TestServiceAllocation {
  /** Unique identifier, e.g. `redis-a1b2c3d4` */
  serviceId: string;
  serviceType: TestServiceType;
  graphId: string;
  /** Task that requested the service */
  taskId: string;
  /** ClusterIP Service hostname workers connect to */
  host: string;
  port: number;
  /** Ready-to-use connection string for the service type */
  connectionString: string;
  /** Absolute unix timestamp ms when the lease expires */
  leaseExpiresAt: number;
  status: "starting" | "ready" | "stopped" | "expired";
  /** Image the Pod is running, e.g. `redis:7` */
  image: string;
}

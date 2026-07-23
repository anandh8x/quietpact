export type ProjectorReadiness = "starting" | "ok" | "degraded" | "disabled";

export interface SafeReadinessReport {
  readonly name: "quietpact-api";
  readonly status: "ready" | "starting" | "degraded";
  readonly database: "ok" | "degraded";
  readonly databaseSchemaVersion: number;
  readonly projector: ProjectorReadiness;
  readonly consecutiveProjectorFailures: number;
  readonly lastProjectorSuccessAt: string | null;
  readonly uptimeSeconds: number;
}

export interface OperationalMonitor {
  projectorSucceeded(): void;
  projectorFailed(): void;
  snapshot(): SafeReadinessReport;
}

export function createOperationalMonitor(options: {
  readonly checkDatabase: () => void;
  readonly databaseSchemaVersion: number;
  readonly projectorDisabled: boolean;
  readonly now?: () => number;
}): OperationalMonitor {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let consecutiveProjectorFailures = 0;
  let lastProjectorSuccessAt: number | null = null;

  return {
    projectorSucceeded() {
      consecutiveProjectorFailures = 0;
      lastProjectorSuccessAt = now();
    },
    projectorFailed() {
      consecutiveProjectorFailures += 1;
    },
    snapshot() {
      const timestamp = now();
      let database: SafeReadinessReport["database"] = "ok";
      try {
        options.checkDatabase();
      } catch {
        database = "degraded";
      }

      const projector: ProjectorReadiness = options.projectorDisabled
        ? "disabled"
        : consecutiveProjectorFailures >= 3
          ? "degraded"
          : lastProjectorSuccessAt === null
            ? "starting"
            : consecutiveProjectorFailures === 0
              ? "ok"
              : "degraded";
      const status: SafeReadinessReport["status"] =
        database === "degraded" || (projector === "degraded" && consecutiveProjectorFailures >= 3)
          ? "degraded"
          : projector === "starting"
            ? "starting"
            : "ready";

      return Object.freeze({
        name: "quietpact-api",
        status,
        database,
        databaseSchemaVersion: options.databaseSchemaVersion,
        projector,
        consecutiveProjectorFailures,
        lastProjectorSuccessAt:
          lastProjectorSuccessAt === null ? null : new Date(lastProjectorSuccessAt).toISOString(),
        uptimeSeconds: Math.max(0, Math.floor((timestamp - startedAt) / 1000)),
      });
    },
  };
}

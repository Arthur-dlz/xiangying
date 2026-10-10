export interface ConfigChange {
  key: string;
  value: unknown;
}

/**
 * A GET snapshot is older than any SSE received while that GET was in
 * flight. A later event therefore acts as an ordering barrier for its key,
 * even when it merely acknowledges a local pending value and needs no state
 * update of its own.
 */
export function mergeDeferredConfigChanges(
  deferredSnapshot: ConfigChange[],
  laterChanges: ConfigChange[],
  applyLaterChange: (change: ConfigChange) => boolean,
): ConfigChange[] {
  const deferredSnapshotByKey = new Map(
    deferredSnapshot.map((change) => [change.key, change]),
  );
  const deferredLaterByKey = new Map<string, ConfigChange>();

  laterChanges.forEach((change) => {
    deferredSnapshotByKey.delete(change.key);
    deferredLaterByKey.delete(change.key);
    if (!applyLaterChange(change)) {
      deferredLaterByKey.set(change.key, change);
    }
  });

  return [...deferredSnapshotByKey.values(), ...deferredLaterByKey.values()];
}

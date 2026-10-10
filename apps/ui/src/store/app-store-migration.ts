export function migrateAppStore<T>(persistedState: T): T {
  if (
    persistedState === null ||
    typeof persistedState !== "object" ||
    Array.isArray(persistedState)
  ) {
    return persistedState;
  }

  const { mcpPort: _legacyMCPPort, ...migrated } = persistedState as Record<
    string,
    unknown
  >;
  return migrated as T;
}

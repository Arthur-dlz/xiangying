interface FilterableSource {
  name: string;
  url: string;
  documentURL: string;
}

export function filterSources<T extends FilterableSource>(
  sources: T[],
  query: string,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) return sources;

  return sources.filter((source) =>
    [source.name, source.url, source.documentURL].some((value) =>
      value.toLowerCase().includes(normalizedQuery),
    ),
  );
}

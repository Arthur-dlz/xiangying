import useSWR from "swr";
import {
  getFavoritesKey,
  getFavorites,
  addFavorite as addFavApi,
  removeFavorite as removeFavApi,
  resolveFavoriteIcon as resolveFavoriteIconApi,
} from "@/api/favorite";
import type { Favorite } from "@mediago/common";
import { useMemoizedFn } from "ahooks";

export function useFavorites() {
  const { data, isLoading, error, mutate } = useSWR(
    getFavoritesKey,
    getFavorites,
  );

  const addFavorite = async (fav: {
    title: string;
    url: string;
    icon?: string;
  }) => {
    await addFavApi(fav);
    mutate();
  };

  const removeFavorite = async (id: number) => {
    await removeFavApi(id);
    mutate();
  };

  const resolveFavoriteIcon = useMemoizedFn(async (id: number) => {
    const resolved = await resolveFavoriteIconApi(id);
    await mutate(
      (current) =>
        Array.isArray(current)
          ? current.map((favorite) =>
              favorite.id === resolved.id ? resolved : favorite,
            )
          : current,
      { revalidate: false },
    );
    return resolved;
  });

  return {
    data: Array.isArray(data) ? data : ([] as Favorite[]),
    isLoading,
    error,
    mutate,
    addFavorite,
    removeFavorite,
    resolveFavoriteIcon,
  };
}

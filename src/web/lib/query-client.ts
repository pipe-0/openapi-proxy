import { QueryClient } from "@tanstack/react-query";
import { RequestError } from "@/lib/api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 4xx is an answer, not a blip: retrying it only delays showing it.
      retry: (failures, error) =>
        failures < 2 && !(error instanceof RequestError && error.status < 500),
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
  },
});

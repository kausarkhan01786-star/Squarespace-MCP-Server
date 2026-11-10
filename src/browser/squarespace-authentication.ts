export type SquarespaceAuthenticationState = "authenticated" | "not_logged_in" | "pending";

export interface SquarespaceAuthenticationSignals {
  hostname: string;
  pathname: string;
  loginFormVisible: boolean;
  dashboardEvidenceVisible: boolean;
  dashboardMarkerPresent: boolean;
  websiteCardCount: number;
}

export function classifySquarespaceAuthentication(
  signals: SquarespaceAuthenticationSignals,
): SquarespaceAuthenticationState {
  const hostname = signals.hostname.toLowerCase();
  const pathname = signals.pathname.toLowerCase();
  if (
    hostname === "login.squarespace.com" ||
    /(?:^|\/)(?:login|sign.?in)(?:\/|$)/i.test(pathname) ||
    signals.loginFormVisible
  ) {
    return "not_logged_in";
  }
  if (hostname !== "account.squarespace.com") return "pending";
  return signals.dashboardMarkerPresent || signals.websiteCardCount > 0
    ? "authenticated"
    : "pending";
}

export async function waitForSquarespaceAuthentication(
  readSignals: () => Promise<SquarespaceAuthenticationSignals>,
  options: {
    timeoutMs: number;
    pollIntervalMs: number;
    delay?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<SquarespaceAuthenticationState> {
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + options.timeoutMs;

  while (true) {
    const state = classifySquarespaceAuthentication(await readSignals());
    if (state !== "pending") return state;
    const remaining = deadline - now();
    if (remaining <= 0) return "pending";
    await delay(Math.min(options.pollIntervalMs, remaining));
  }
}

// Shared LIFF SDK typings.
//
// LIFF (LINE Frontend Framework) is loaded as a runtime <Script> tag from
// LINE's CDN, then attaches itself to `window.liff`. We type only the
// methods we actually call. Declaring this in multiple files causes
// "Subsequent property declarations must have the same type" build
// errors because each declare-global creates its own structural identity
// — so put the global augmentation here once and import the type where
// needed.

export type LiffProfile = {
  userId: string;
  displayName: string;
  pictureUrl?: string;
};

export type LiffSDK = {
  init: (cfg: { liffId: string }) => Promise<void>;
  ready: Promise<void>;
  isInClient: () => boolean;
  isLoggedIn: () => boolean;
  login: (cfg?: { redirectUri?: string }) => void;
  getProfile: () => Promise<LiffProfile>;
  // Access token used to call LINE Profile API server-side and verify
  // the userId — needed by the one-tap rich-menu login bridge so the
  // server doesn't have to trust a client-asserted userId.
  getAccessToken: () => string | null;
};

declare global {
  interface Window {
    liff?: LiffSDK;
  }
}

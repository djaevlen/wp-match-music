export interface Boot {
  restUrl: string;
  nonce: string;
  nonceUrl: string;
  canEdit: boolean;
  maxUploadBytes: number;
  loginUrl: string;
  fadeMs: number;
}

declare global {
  interface Window {
    MatchMusicBoot?: Boot;
  }
}

export function getBoot(): Boot {
  if (!window.MatchMusicBoot) {
    throw new Error('MatchMusicBoot is missing: the board must be served by the plugin.');
  }
  return window.MatchMusicBoot;
}

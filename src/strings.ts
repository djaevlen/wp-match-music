// The single home of UI text. Everything the board shows is English and lives here.
export const strings = {
  appTitle: 'Match music',
  board: {
    loadingProgress: (loaded: number, total: number) => `Loading ${loaded}/${total}`,
    fade: (seconds: string) => `Fade ${seconds} s`,
    noTracks: 'No tracks yet.',
    unreachable: 'The server could not be reached.',
    retry: 'Retry',
    logIn: 'Log in',
  },
  row: {
    play: 'Play',
    stop: 'Stop',
    retry: 'Retry',
    startsAt: (time: string) => `starts ${time}`,
    playing: (elapsed: string) => `${elapsed} playing`,
    fading: 'fading',
    loading: 'Loading…',
    loadFailed: 'Could not load',
  },
  // Shown when the API client itself fails; server errors keep the server's own message.
  errors: {
    tooLarge: 'The file is too large to upload.',
    network: 'The network request failed. Check your connection and try again.',
    badResponse: 'The server sent a reply the board could not read.',
    httpStatus: (status: number) => `The server replied with an error (HTTP ${status}).`,
    sessionExpired: 'The session has expired. Log in again to continue.',
  },
} as const;

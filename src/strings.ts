// The single home of UI text. Everything the board shows is English and lives here.
export const strings = {
  appTitle: 'Match music',
  // Shown when the API client itself fails; server errors keep the server's own message.
  errors: {
    tooLarge: 'The file is too large to upload.',
    network: 'The network request failed. Check your connection and try again.',
    badResponse: 'The server sent a reply the board could not read.',
    httpStatus: (status: number) => `The server replied with an error (HTTP ${status}).`,
    sessionExpired: 'The session has expired. Log in again to continue.',
  },
} as const;

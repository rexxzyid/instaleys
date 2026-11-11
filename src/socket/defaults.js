export const DisconnectReason = {
  connectionClosed: 428,
  connectionLost: 408,
  connectionReplaced: 440,
  timedOut: 408,
  loggedOut: 401,
  badSession: 500,
  restartRequired: 515,
  multideviceMismatch: 411,
  forbidden: 403,
  unavailableService: 503,
  rateLimited: 429,
  challengeRequired: 460
}

export class DisconnectError extends Error {
  constructor(message, statusCode = DisconnectReason.connectionClosed, data = null) {
    super(message)
    this.name = 'DisconnectError'
    this.isBoom = true
    this.data = data
    this.output = {
      statusCode,
      payload: { statusCode, error: message, message }
    }
  }
}

export class NotSupportedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NotSupportedError'
  }
}

export const DEFAULT_SOCKET_CONFIG = {
  auth: null,
  credentials: null,
  twoFactorCode: null,
  proxy: null,
  logger: null,
  device: null,
  delayRange: null,
  requestTimeout: 1,
  transport: 'poll',
  pollIntervalMs: 10000,
  pollJitter: 0.25,
  pendingPollEvery: 6,
  historyLimit: 20,
  messageLimit: 20,
  syncFullHistory: false,
  emitOwnEvents: true,
  autoLogin: true,
  maxBackoffMs: 900000,
  shouldIgnoreJid: () => false,
  shouldSyncHistoryMessage: () => true,
  clientOptions: {}
}

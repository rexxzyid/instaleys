import { NotSupportedError } from './defaults.js'

export const POLL_TRANSPORT = 'poll'
export const MQTT_TRANSPORT = 'mqtt'

export const resolveRealtimeTransport = (transport = POLL_TRANSPORT) => {
  if (transport === POLL_TRANSPORT) return { type: 'poll', name: 'poll' }
  if (transport === MQTT_TRANSPORT) throw new NotSupportedError('Realtime transport "mqtt" is not ported yet')
  throw new NotSupportedError(`Realtime transport "${String(transport)}" is not supported`)
}

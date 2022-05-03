/**
 * @module util
 */
import { platform } from 'os'
import { version as packageVersion } from '../../package.json'

export * from './parse'
export * from './rpc'

export function short(buf: Buffer | string): string {
  if (!buf) return ''
  const bufStr = Buffer.isBuffer(buf) ? `0x${buf.toString('hex')}` : buf
  let str = bufStr.substring(0, 6) + '…'
  if (bufStr.length === 66) {
    str += bufStr.substring(62)
  }
  return str
}

export function getClientVersion() {
  const { version } = process
  return `EthereumJS/${packageVersion}/${platform()}/node${version.substring(1)}`
}

/**
 * Returns a friendly time duration.
 * @param time the number of seconds
 */
export function timeDuration(time: number) {
  const min = 60
  const hour = min * 60
  const day = hour * 24
  let str = ''
  if (time > day) {
    str = `${Math.floor(time / day)} day`
  } else if (time > hour) {
    str = `${Math.floor(time / hour)} hour`
  } else if (time > min) {
    str = `${Math.floor(time / min)} min`
  } else {
    str = `${Math.floor(time)} sec`
  }
  if (str.substring(0, 2) !== '1 ') {
    str += 's'
  }
  return str
}

/**
 * Returns a friendly time diff string.
 * @param timestamp the timestamp to diff (in seconds) from now
 */
export function timeDiff(timestamp: number) {
  const diff = new Date().getTime() / 1000 - timestamp
  return timeDuration(diff)
}

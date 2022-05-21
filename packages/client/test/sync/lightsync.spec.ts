import tape from 'tape'
import td from 'testdouble'
import { BN } from 'ethereumjs-util'
import { Config } from '../../lib/config'
import { Chain } from '../../lib/blockchain'
import { Event } from '../../lib/types'
import { BlockHeader } from '@ethereumjs/block'

tape('[LightSynchronizer]', async (t) => {
  class PeerPool {
    open() {}
    close() {}
  }
  PeerPool.prototype.open = td.func<any>()
  PeerPool.prototype.close = td.func<any>()
  class HeaderFetcher {
    fetch() {}
    clear() {}
    destroy() {}
  }
  HeaderFetcher.prototype.fetch = td.func<any>()
  td.replace('../../lib/sync/fetcher', { HeaderFetcher })

  const { LightSynchronizer } = await import('../../lib/sync/lightsync')

  t.test('should initialize correctly', async (t) => {
    const config = new Config({ transports: [] })
    const pool = new PeerPool() as any
    const chain = new Chain({ config })
    const sync = new LightSynchronizer({ config, pool, chain })
    t.equals(sync.type, 'light', 'light type')
    t.end()
  })

  t.test('should find best', async (t) => {
    const config = new Config({ transports: [] })
    const pool = new PeerPool() as any
    const chain = new Chain({ config })
    const sync = new LightSynchronizer({
      config,
      interval: 1,
      pool,
      chain,
    })
    ;(sync as any).running = true
    ;(sync as any).chain = { headers: { td: new BN(1) } }
    const peers = [
      {
        les: { status: { headTd: new BN(1), headNum: new BN(1), serveHeaders: 1 } },
        inbound: false,
      },
      {
        les: { status: { headTd: new BN(2), headNum: new BN(2), serveHeaders: 1 } },
        inbound: false,
      },
    ]
    ;(sync as any).pool = { peers }
    ;(sync as any).forceSync = true
    t.equal(await sync.best(), peers[1], 'found best')
    t.end()
  })

  t.test('should sync', async (t) => {
    t.plan(3)
    const config = new Config({ transports: [], safeReorgDistance: 0 })
    const pool = new PeerPool() as any
    const chain = new Chain({ config })
    const sync = new LightSynchronizer({
      config,
      interval: 1,
      pool,
      chain,
    })
    sync.best = td.func<typeof sync['best']>()
    sync.latest = td.func<typeof sync['latest']>()
    td.when(sync.best()).thenResolve({ les: { status: { headNum: new BN(2) } } } as any)
    td.when(sync.latest(td.matchers.anything())).thenResolve({
      number: new BN(2),
      hash: () => Buffer.from([]),
    })
    td.when(HeaderFetcher.prototype.fetch(), { delay: 20, times: 2 }).thenResolve(undefined)
    ;(sync as any).chain = { headers: { height: new BN(3) } }
    t.notOk(await sync.sync(), 'local height > remote height')
    ;(sync as any).chain = { headers: { height: new BN(0) } }
    setTimeout(() => {
      config.events.emit(Event.SYNC_SYNCHRONIZED, new BN(0))
    }, 100)
    t.ok(await sync.sync(), 'local height < remote height')
    td.when(HeaderFetcher.prototype.fetch()).thenReject(new Error('err0'))
    try {
      await sync.sync()
    } catch (err: any) {
      t.equals(err.message, 'err0', 'got error')
      await sync.stop()
      await sync.close()
    }
  })

  t.test('import headers', async (st) => {
    td.reset()
    st.plan(1)
    const config = new Config({ transports: [], safeReorgDistance: 0 })
    const pool = new PeerPool() as any
    const chain = new Chain({ config })
    const sync = new LightSynchronizer({
      config,
      interval: 1,
      pool,
      chain,
    })
    sync.best = td.func<typeof sync['best']>()
    sync.latest = td.func<typeof sync['latest']>()
    td.when(sync.best()).thenResolve({ les: { status: { headNum: new BN(2) } } } as any)
    td.when(sync.latest(td.matchers.anything())).thenResolve({
      number: new BN(2),
      hash: () => Buffer.from([]),
    })
    td.when(HeaderFetcher.prototype.fetch()).thenResolve(undefined)
    td.when(HeaderFetcher.prototype.fetch()).thenDo(() =>
      config.events.emit(Event.SYNC_FETCHED_HEADERS, [BlockHeader.fromHeaderData({})])
    )
    config.logger.on('data', async (data) => {
      if (data.message.includes('Imported headers count=1')) {
        st.pass('successfully imported new header')
        config.logger.removeAllListeners()
        await sync.stop()
        await sync.close()
      }
    })
    await sync.sync()
  })

  t.test('sync errors', async (st) => {
    td.reset()
    st.plan(1)
    const config = new Config({ transports: [] })
    const pool = new PeerPool() as any
    const chain = new Chain({ config })
    const sync = new LightSynchronizer({
      config,
      interval: 1,
      pool,
      chain,
    })
    sync.best = td.func<typeof sync['best']>()
    sync.latest = td.func<typeof sync['latest']>()
    td.when(sync.best()).thenResolve({ les: { status: { headNum: new BN(2) } } } as any)
    td.when(sync.latest(td.matchers.anything())).thenResolve({
      number: new BN(2),
      hash: () => Buffer.from([]),
    })
    td.when(HeaderFetcher.prototype.fetch()).thenResolve(undefined)
    td.when(HeaderFetcher.prototype.fetch()).thenDo(() =>
      config.events.emit(Event.SYNC_FETCHED_HEADERS, [] as BlockHeader[])
    )
    config.logger.on('data', async (data) => {
      if (data.message.includes('No headers fetched are applicable for import')) {
        st.pass('generated correct warning message when no headers received')
        config.logger.removeAllListeners()
        await sync.stop()
        await sync.close()
      }
    })
    await sync.sync()
  })
})

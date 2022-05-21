import tape from 'tape'
import td from 'testdouble'
import Common, { Chain as CommonChain, Hardfork } from '@ethereumjs/common'
import { FeeMarketEIP1559Transaction, Transaction } from '@ethereumjs/tx'
import { Block, BlockHeader } from '@ethereumjs/block'
import { DefaultStateManager, StateManager } from '@ethereumjs/vm/dist/state'
import { Account, Address, BN, keccak256 } from 'ethereumjs-util'
import { Config } from '../../lib/config'
import { FullEthereumService } from '../../lib/service'
import { Chain } from '../../lib/blockchain'
import { Miner } from '../../lib/miner'
import { Event } from '../../lib/types'
import { wait } from '../integration/util'
import type { FullSynchronizer } from '../../lib/sync'

const A = {
  address: new Address(Buffer.from('0b90087d864e82a284dca15923f3776de6bb016f', 'hex')),
  privateKey: Buffer.from(
    '64bf9cc30328b0e42387b3c82c614e6386259136235e20c1357bd11cdee86993',
    'hex'
  ),
}

const B = {
  address: new Address(Buffer.from('6f62d8382bf2587361db73ceca28be91b2acb6df', 'hex')),
  privateKey: Buffer.from(
    '2a6e9ad5a6a8e4f17149b8bc7128bf090566a11dbd63c30e5a0ee9f161309cd6',
    'hex'
  ),
}

const setBalance = async (stateManager: StateManager, address: Address, balance: BN) => {
  // this fn can be replaced with modifyAccountFields() when #1369 is available
  await stateManager.checkpoint()
  await stateManager.putAccount(address, new Account(new BN(0), balance))
  await stateManager.commit()
}

tape('[Miner]', async (t) => {
  const originalValidate = BlockHeader.prototype.validate
  BlockHeader.prototype.validate = td.func<any>()
  td.replace('@ethereumjs/block', { BlockHeader })

  const originalSetStateRoot = DefaultStateManager.prototype.setStateRoot
  DefaultStateManager.prototype.setStateRoot = td.func<any>()
  td.replace('@ethereumjs/vm/dist/state', { DefaultStateManager })

  class FakeChain {
    open() {}
    close() {}
    update() {}
    get headers() {
      return {
        latest: BlockHeader.fromHeaderData(),
        height: new BN(0),
      }
    }
    get blocks() {
      return {
        latest: Block.fromBlockData(),
        height: new BN(0),
      }
    }
    getLatestHeader() {
      return BlockHeader.fromHeaderData()
    }
    blockchain: any = {
      putBlock: async () => {},
      cliqueActiveSigners: () => [A.address],
      cliqueSignerInTurn: async () => true,
      cliqueCheckRecentlySigned: () => false,
      // eslint-disable-next-line no-invalid-this
      copy: () => this.blockchain,
    }
  }

  const common = new Common({ chain: CommonChain.Rinkeby, hardfork: Hardfork.Berlin })
  common.setMaxListeners(50)
  const accounts: [Address, Buffer][] = [[A.address, A.privateKey]]
  const config = new Config({ transports: [], accounts, mine: true, common })
  config.events.setMaxListeners(50)

  const createTx = (
    from = A,
    to = B,
    nonce = 0,
    value = 1,
    gasPrice = 1000000000,
    gasLimit = 100000
  ) => {
    const txData = {
      nonce,
      gasPrice,
      gasLimit,
      to: to.address,
      value,
    }
    const tx = Transaction.fromTxData(txData, { common })
    const signedTx = tx.sign(from.privateKey)
    return signedTx
  }

  const txA01 = createTx() // A -> B, nonce: 0, value: 1, normal gasPrice
  const txA02 = createTx(A, B, 1, 1, 2000000000) // A -> B, nonce: 1, value: 1, 2x gasPrice
  const txA03 = createTx(A, B, 2, 1, 3000000000) // A -> B, nonce: 2, value: 1, 3x gasPrice
  const txB01 = createTx(B, A, 0, 1, 2500000000) // B -> A, nonce: 0, value: 1, 2.5x gasPrice

  t.test('should initialize correctly', (t) => {
    const chain = new FakeChain() as any
    const service = new FullEthereumService({
      config,
      chain,
    })
    const miner = new Miner({ config, service })
    t.notOk(miner.running)
    t.end()
  })

  t.test('should start/stop', async (t) => {
    t.plan(4)
    const chain = new FakeChain() as any
    const service = new FullEthereumService({
      config,
      chain,
    })
    let miner = new Miner({ config, service })
    t.notOk(miner.running)
    miner.start()
    t.ok(miner.running)
    await wait(10)
    miner.stop()
    t.notOk(miner.running)

    // Should not start when config.mine=false
    const configMineFalse = new Config({ transports: [], accounts, mine: false })
    miner = new Miner({ config: configMineFalse, service })
    miner.start()
    t.notOk(miner.running, 'miner should not start when config.mine=false')
  })

  t.test('assembleBlocks() -> with a single tx', async (t) => {
    t.plan(1)
    const chain = new FakeChain() as any
    const service = new FullEthereumService({
      config,
      chain,
    })
    const miner = new Miner({ config, service })
    const { txPool } = service
    const { vm } = service.execution

    txPool.start()
    miner.start()

    await setBalance(vm.stateManager, A.address, new BN('200000000000001'))

    // add tx
    await txPool.add(txA01)

    // disable consensus to skip PoA block signer validation
    ;(vm.blockchain as any)._validateConsensus = false

    chain.putBlocks = (blocks: Block[]) => {
      t.equal(blocks[0].transactions.length, 1, 'new block should include tx')
      miner.stop()
      txPool.stop()
    }
    await (miner as any).queueNextAssembly(0)
    await wait(500)
  })

  t.test(
    'assembleBlocks() -> with multiple txs, properly ordered by gasPrice and nonce',
    async (t) => {
      t.plan(4)
      const chain = new FakeChain() as any
      const service = new FullEthereumService({
        config,
        chain,
      })
      const miner = new Miner({ config, service })
      const { txPool } = service
      const { vm } = service.execution
      txPool.start()
      miner.start()

      await setBalance(vm.stateManager, A.address, new BN('400000000000001'))
      await setBalance(vm.stateManager, B.address, new BN('400000000000001'))

      // add txs
      await txPool.add(txA01)
      await txPool.add(txA02)
      await txPool.add(txA03)
      await txPool.add(txB01)

      // disable consensus to skip PoA block signer validation
      ;(vm.blockchain as any)._validateConsensus = false

      chain.putBlocks = (blocks: Block[]) => {
        const msg = 'txs in block should be properly ordered by gasPrice and nonce'
        const expectedOrder = [txB01, txA01, txA02, txA03]
        for (const [index, tx] of expectedOrder.entries()) {
          t.ok(blocks[0].transactions[index].hash().equals(tx.hash()), msg)
        }
        miner.stop()
        txPool.stop()
      }
      await (miner as any).queueNextAssembly(0)
      await wait(500)
    }
  )

  t.test('assembleBlocks() -> should not include tx under the baseFee', async (t) => {
    t.plan(1)
    const customChainParams = { hardforks: [{ name: 'london', block: 0 }] }
    const common = Common.forCustomChain(CommonChain.Rinkeby, customChainParams, Hardfork.London)
    const config = new Config({ transports: [], accounts, mine: true, common })
    const chain = new FakeChain() as any
    const block = Block.fromBlockData({}, { common })
    Object.defineProperty(chain, 'headers', {
      get: function () {
        return { latest: block.header }
      },
    })
    Object.defineProperty(chain, 'blocks', {
      get: function () {
        return { latest: block }
      },
    })
    const service = new FullEthereumService({
      config,
      chain,
    })
    const miner = new Miner({ config, service })
    const { txPool } = service
    const { vm } = service.execution
    txPool.start()
    miner.start()

    // the default block baseFee will be 7
    // add tx with maxFeePerGas of 6
    const tx = FeeMarketEIP1559Transaction.fromTxData(
      { to: B.address, maxFeePerGas: 6 },
      { common }
    ).sign(A.privateKey)
    await txPool.add(tx, true)

    // disable consensus to skip PoA block signer validation
    ;(vm.blockchain as any)._validateConsensus = false
    ;(service.synchronizer as FullSynchronizer).handleNewBlock = async (block: Block) => {
      t.equal(block.transactions.length, 0, 'should not include tx')
      miner.stop()
      txPool.stop()
    }
    await wait(500)
    await (miner as any).queueNextAssembly(0)
    await wait(500)
  })

  t.test("assembleBlocks() -> should stop assembling a block after it's full", async (t) => {
    t.plan(1)
    const chain = new FakeChain() as any
    const gasLimit = 100000
    const block = Block.fromBlockData({ header: { gasLimit } }, { common })
    Object.defineProperty(chain, 'headers', {
      get: function () {
        return { latest: block.header, height: new BN(0) }
      },
    })
    Object.defineProperty(chain, 'blocks', {
      get: function () {
        return { latest: block, height: new BN(0) }
      },
    })
    const service = new FullEthereumService({
      config,
      chain,
    })
    const miner = new Miner({ config, service })
    const { txPool } = service
    const { vm } = service.execution
    txPool.start()
    miner.start()

    await setBalance(vm.stateManager, A.address, new BN('200000000000001'))

    // add txs
    const data = '0xfe' // INVALID opcode, consumes all gas
    const tx1FillsBlockGasLimit = Transaction.fromTxData(
      { gasLimit: gasLimit - 1, data, gasPrice: new BN(1000000000) },
      { common }
    ).sign(A.privateKey)
    const tx2ExceedsBlockGasLimit = Transaction.fromTxData(
      { gasLimit: 21000, to: B.address, nonce: 1, gasPrice: new BN(1000000000) },
      { common }
    ).sign(A.privateKey)
    await txPool.add(tx1FillsBlockGasLimit)
    await txPool.add(tx2ExceedsBlockGasLimit)

    // disable consensus to skip PoA block signer validation
    ;(vm.blockchain as any)._validateConsensus = false

    chain.putBlocks = (blocks: Block[]) => {
      t.equal(blocks[0].transactions.length, 1, 'only one tx should be included')
      miner.stop()
      txPool.stop()
    }
    await (miner as any).queueNextAssembly(0)
    await wait(500)
  })

  t.test('assembleBlocks() -> should stop assembling when a new block is received', async (t) => {
    t.plan(2)
    const chain = new FakeChain() as any
    const config = new Config({ transports: [], accounts, mine: true, common })
    const service = new FullEthereumService({
      config,
      chain,
    })
    const miner = new Miner({ config, service })

    // stub chainUpdated so assemble isn't called again
    // when emitting Event.CHAIN_UPDATED in this test
    ;(miner as any).chainUpdated = async () => {}

    const { txPool } = service
    const { vm } = service.execution
    txPool.start()
    miner.start()

    // add many txs to slow assembling
    let privateKey = keccak256(Buffer.from(''))
    for (let i = 0; i < 1000; i++) {
      // In order not to pollute TxPool with too many txs from the same address
      // (or txs which are already known), keep generating a new address for each tx
      const address = Address.fromPrivateKey(privateKey)
      await setBalance(vm.stateManager, address, new BN('200000000000001'))
      const tx = createTx({ address, privateKey })
      await txPool.add(tx)
      privateKey = keccak256(privateKey)
    }

    chain.putBlocks = () => {
      t.fail('should have stopped assembling when a new block was received')
    }
    await (miner as any).queueNextAssembly(5)
    await wait(5)
    t.ok((miner as any).assembling, 'miner should be assembling')
    config.events.emit(Event.CHAIN_UPDATED)
    await wait(25)
    t.notOk((miner as any).assembling, 'miner should have stopped assembling')
    miner.stop()
    txPool.stop()
  })

  t.test('should handle mining over the london hardfork block', async (t) => {
    const customChainParams = {
      hardforks: [
        { name: 'chainstart', block: 0 },
        { name: 'berlin', block: 2 },
        { name: 'london', block: 3 },
      ],
    }
    const common = Common.custom(customChainParams, { baseChain: CommonChain.Rinkeby })
    common.setHardforkByBlockNumber(0)
    const config = new Config({ transports: [], accounts, mine: true, common })
    const chain = new Chain({ config })
    await chain.open()
    const service = new FullEthereumService({
      config,
      chain,
    })
    const miner = new Miner({ config, service })

    const { vm } = service.execution
    vm.blockchain.cliqueActiveSigners = () => [A.address] // stub
    ;(miner as any).chainUpdated = async () => {} // stub
    miner.start()
    await wait(100)

    // in this test we need to explicitly update common with
    // setHardforkByBlockNumber() to test the hardfork() value
    // since the vmexecution run method isn't reached in this
    // stubbed configuration.

    // block 1: chainstart
    await (miner as any).queueNextAssembly(0)
    await wait(100)
    config.execCommon.setHardforkByBlockNumber(1)
    t.equal(config.execCommon.hardfork(), Hardfork.Chainstart)

    // block 2: berlin
    await (miner as any).queueNextAssembly(0)
    await wait(100)
    config.execCommon.setHardforkByBlockNumber(2)
    t.equal(config.execCommon.hardfork(), Hardfork.Berlin)
    const blockHeader2 = await chain.getLatestHeader()

    // block 3: london
    await (miner as any).queueNextAssembly(0)
    await wait(100)
    const blockHeader3 = await chain.getLatestHeader()
    config.execCommon.setHardforkByBlockNumber(3)
    t.equal(config.execCommon.hardfork(), Hardfork.London)
    t.ok(
      blockHeader2.gasLimit.muln(2).eq(blockHeader3.gasLimit),
      'gas limit should be double previous block'
    )
    const initialBaseFee = new BN(config.execCommon.paramByEIP('gasConfig', 'initialBaseFee', 1559))
    t.ok(blockHeader3.baseFeePerGas!.eq(initialBaseFee), 'baseFee should be initial value')

    // block 4
    await (miner as any).queueNextAssembly(0)
    await wait(100)
    const blockHeader4 = await chain.getLatestHeader()
    config.execCommon.setHardforkByBlockNumber(4)
    t.equal(config.execCommon.hardfork(), Hardfork.London)
    t.ok(
      blockHeader4.baseFeePerGas!.eq(blockHeader3.calcNextBaseFee()),
      'baseFee should be as calculated'
    )
    t.ok((await chain.getLatestHeader()).number.eqn(4))
    miner.stop()
    await chain.close()
  })

  t.test('should handle mining ethash PoW', async (t) => {
    t.plan(1)
    const common = new Common({ chain: CommonChain.Ropsten })
    ;(common as any)._chainParams['genesis'].difficulty = 1
    const config = new Config({ transports: [], accounts, mine: true, common })
    const chain = new Chain({ config })
    await chain.open()
    const service = new FullEthereumService({
      config,
      chain,
    })
    const miner = new Miner({ config, service })
    ;(chain.blockchain as any)._validateConsensus = false
    ;(miner as any).chainUpdated = async () => {} // stub
    miner.start()
    await wait(100)
    config.events.on(Event.CHAIN_UPDATED, async () => {
      t.ok(chain.blocks.latest!.header.number.eqn(1))
      miner.stop()
      await chain.close()
    })
    await (miner as any).queueNextAssembly(0)
    await wait(3000)
  })

  t.test('should reset td', (t) => {
    td.reset()
    // according to https://github.com/testdouble/testdouble.js/issues/379#issuecomment-415868424
    // mocking indirect dependencies is not properly supported, but it works for us in this file,
    // so we will replace the original functions to avoid issues in other tests that come after
    BlockHeader.prototype.validate = originalValidate
    DefaultStateManager.prototype.setStateRoot = originalSetStateRoot
    t.end()
  })
})

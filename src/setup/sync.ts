import Common from '@ethereumjs/common'
import { Shardus, ShardusTypes } from '@shardus/core'
import { Account, Address, BN } from 'ethereumjs-util'
import config from '../config'
import genesis from '../config/genesis.json'
import { loadAccountDataFromDB } from '../shardeum/debugRestoreAccounts'
import { toShardusAddress } from '../shardeum/evmAddress'
import { ShardeumFlags } from '../shardeum/shardeumFlags'
import { AccountType, DevAccount, InternalTXType, WrappedEVMAccount } from '../shardeum/shardeumTypes'
import * as WrappedEVMAccountFunctions from '../shardeum/wrappedEVMAccountFunctions'
import { ShardeumState, TransactionState } from '../state'
import * as AccountsStorage from '../storage/accountStorage'
import { sleep } from '../utils'
import { StateManager } from '../vm/state'

function isDebugMode(): boolean {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  //@ts-ignore
  return config.server.mode === 'debug'
}

const oneEth = new BN(10).pow(new BN(18))

export const networkAccount = config.server.globalAccount

//In debug mode the default value is 100 SHM.  This is needed for certain load test operations
const defaultBalance = isDebugMode() ? oneEth.mul(new BN(100)) : new BN(0)

const debugShardeumState: ShardeumState = null

export const ONE_SECOND = 1000

export const sync = (shardus: Shardus, evmCommon: Common) => async (): Promise<void> => {
  if (ShardeumFlags.useAccountWrites) shardus.useAccountWrites()
  if (ShardeumFlags.GlobalNetworkAccount) {
    if (shardus.p2p.isFirstSeed) {
      await sleep(ONE_SECOND * 5)

      const nodeId = shardus.getNodeId()

      if (ShardeumFlags.DebugRestoreFile != null && ShardeumFlags.DebugRestoreFile != '') {
        const loadOptions = {
          file: ShardeumFlags.DebugRestoreFile,
        }
        const report = await loadAccountDataFromDB(shardus, loadOptions)
        console.log('loadAccountDataFromDB:' + JSON.stringify(report))
      }

      //create genesis accounts before network account since nodes will wait for the network account
      shardus.log(`node ${nodeId} GENERATED_A_NEW_NETWORK_ACCOUNT: `)
      if (ShardeumFlags.SetupGenesisAccount) {
        let skippedAccountCount = 0
        const accountCopies = []
        for (const address in genesis) {
          const amount = new BN(genesis[address].wei) // eslint-disable-line security/detect-object-injection

          const shardusAccountID = toShardusAddress(address, AccountType.Account)
          const existingAccount = await shardus.getLocalOrRemoteAccount(shardusAccountID)
          if (existingAccount) {
            skippedAccountCount += 1
            continue
          }

          const ethAccountID = Address.fromString(address).toString()
          const { wrappedEVMAccount, accountId, cycle } = await manuallyCreateAccount(
            ethAccountID,
            amount,
            evmCommon,
            shardus.getLatestCycles()
          )
          const accountCopy: ShardusTypes.AccountsCopy = {
            cycleNumber: cycle.counter,
            accountId,
            data: wrappedEVMAccount,
            hash: wrappedEVMAccount.hash,
            isGlobal: false,
            timestamp: wrappedEVMAccount.timestamp,
          }
          accountCopies.push(accountCopy)
          shardus.log(`node ${nodeId} SETUP GENESIS ACCOUNT: ${address}  amt: ${amount}`)
        }
        console.log(`Skipped ${skippedAccountCount} genesis accounts`)
        if (ShardeumFlags.devPublicKey) {
          const { account, cycle } = createDevAccount(ShardeumFlags.devPublicKey, shardus.getLatestCycles())
          const devAccount: any = account // eslint-disable-line @typescript-eslint/no-explicit-any
          await AccountsStorage.setAccount(devAccount.id, devAccount)
          const accountCopy: ShardusTypes.AccountsCopy = {
            cycleNumber: cycle.counter,
            accountId: devAccount.id,
            data: devAccount,
            hash: devAccount.hash,
            isGlobal: false,
            timestamp: devAccount.timestamp,
          }
          accountCopies.push(accountCopy)
        }
        await shardus.debugCommitAccountCopies(accountCopies)
        if (ShardeumFlags.forwardGenesisAccounts) {
          await shardus.forwardAccounts({ accounts: accountCopies, receipts: [] })
        }
      }
      await sleep(ONE_SECOND * 10)

      const when = Date.now()
      const existingNetworkAccount = await shardus.getLocalOrRemoteAccount(networkAccount)
      if (existingNetworkAccount) {
        shardus.log('NETWORK_ACCOUNT ALREADY EXISTED: ', existingNetworkAccount)
        await sleep(ONE_SECOND * 5)
      } else {
        const value = {
          isInternalTx: true,
          internalTXType: InternalTXType.InitNetwork,
          timestamp: when,
          network: networkAccount,
        }
        shardus.setGlobal(networkAccount, value, when, networkAccount)
      }
    } else {
      while (!(await shardus.getLocalOrRemoteAccount(networkAccount))) {
        console.log('waiting..')
        await sleep(1000)
      }
    }
  }
}

/**
 * This creates an account outside of any EVM transaction
 * @param ethAccountID
 * @param balance
 */
async function manuallyCreateAccount(
  ethAccountID: string,
  balance = defaultBalance,
  evmCommon: Common,
  latestCycles: any // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<{
  accountId: string
  wrappedEVMAccount: {
    timestamp: number
    account: Account
    ethAddress: string
    hash: string
    accountType: AccountType
  }
  cycle: { counter: number }
}> {
  const shardusAccountID = toShardusAddress(ethAccountID, AccountType.Account)

  const debugTXState = getDebugTXState(evmCommon) //this isn't so great..
  debugTXState.checkpoint()
  const newAccount = await createAccount(ethAccountID, debugTXState, balance)
  debugTXState.commit()

  const { accounts: accountWrites } = debugTXState._transactionState.getWrittenAccounts()

  //need to commit the account now... this is such a hack!!
  for (const account of accountWrites.entries()) {
    //1. wrap and save/update this to shardeum accounts[] map
    const addressStr = account[0]
    const accountObj = Account.fromRlpSerializedAccount(account[1])

    const ethAccount = accountObj
    debugTXState._transactionState.commitAccount(addressStr, ethAccount) //yikes this wants an await.
  }

  if (ShardeumFlags.VerboseLogs) console.log('Tester account created', newAccount)
  const address = Address.fromString(ethAccountID)
  const account = await debugTXState.getAccount(address)

  let cycleStart = 0
  if (latestCycles != null && latestCycles.length > 0) {
    cycleStart = latestCycles[0].start * 1000
    console.log('Tester account created time: ', cycleStart)
  }

  const wrappedEVMAccount = {
    timestamp: cycleStart,
    account,
    ethAddress: ethAccountID,
    hash: '',
    accountType: AccountType.Account,
  }
  WrappedEVMAccountFunctions.updateEthAccountHash(wrappedEVMAccount)
  return { accountId: shardusAccountID, wrappedEVMAccount, cycle: latestCycles[0] }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createDevAccount = (accountId: string, latestCycles: any): { account: DevAccount; cycle: any } => {
  let cycleStart = 0
  if (latestCycles != null && latestCycles.length > 0) {
    cycleStart = latestCycles[0].start * 1000
    console.log('dev account created time: ', cycleStart)
  }
  const account: DevAccount = {
    id: accountId,
    accountType: AccountType.DevAccount,
    hash: '',
    timestamp: cycleStart,
  }
  account.hash = WrappedEVMAccountFunctions._calculateAccountHash(account)
  return { account, cycle: latestCycles[0] }
}

/**
 * Cant be used in parallel
 * @returns
 */
function getDebugTXState(evmCommon: Common): ShardeumState {
  const txId = '7'.repeat(64)
  if (ShardeumFlags.VerboseLogs) console.log('Creating a debug tx ShardeumState for ')

  let shardeumState = debugShardeumState
  if (shardeumState == null) {
    shardeumState = new ShardeumState({ common: evmCommon })
    const transactionState = new TransactionState()
    transactionState.initData(
      shardeumState,
      {
        //don't define callbacks for db TX state!
        storageMiss: accountMissNoOp,
        contractStorageMiss: contractStorageMissNoOp,
        accountInvolved: accountInvolvedNoOp,
        contractStorageInvolved: contractStorageInvolvedNoOp,
        tryGetRemoteAccountCB: tryGetRemoteAccountCBNoOp,
        monitorEventCB: () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
      },
      txId,
      undefined,
      undefined
    )
    shardeumState.setTransactionState(transactionState)
  } else {
    //TODO possibly need a blob to re-init with, but that may happen somewhere else.  Will require a slight interface change
    //to allow shardus to pass in this extra data blob (unless we find a way to run it through wrapped states??)
    if (ShardeumFlags.VerboseLogs) console.log('Resetting debug transaction state for txId', txId)
    shardeumState.resetState()
  }

  return shardeumState
}

async function createAccount(
  addressStr: string,
  stateManager: StateManager,
  balance: BN = defaultBalance
): Promise<WrappedEVMAccount> {
  if (ShardeumFlags.VerboseLogs) console.log('Creating new account', addressStr)
  const accountAddress = Address.fromString(addressStr)

  const acctData = {
    nonce: 0,
    balance: balance, // 100 eth in debug mode.  0 ETH in release mode
  }

  //I think this will have to change in the future!
  // shardeumStateManager.setTransactionState(transactionState)

  const account = Account.fromAccountData(acctData)
  await stateManager.putAccount(accountAddress, account)
  const updatedAccount = await stateManager.getAccount(accountAddress)

  const wrappedEVMAccount = {
    timestamp: 0,
    account: updatedAccount,
    ethAddress: addressStr,
    hash: '',
    accountType: AccountType.Account,
  }
  WrappedEVMAccountFunctions.updateEthAccountHash(wrappedEVMAccount)
  return wrappedEVMAccount
}

/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * fake callbacks so that the debug transactionState object can work with creating test accounts
 * Probably not a good thing to have long term.
 */
async function accountMissNoOp(_transactionState: TransactionState, _address: string): Promise<boolean> {
  const isRemoteShard = false
  return isRemoteShard
}

async function contractStorageMissNoOp(
  _transactionState: TransactionState,
  _address: string,
  _key: string
): Promise<boolean> {
  const isRemoteShard = false
  return isRemoteShard
}

function accountInvolvedNoOp(
  _transactionState: TransactionState,
  _address: string,
  _isRead: boolean
): boolean {
  return true
}

function contractStorageInvolvedNoOp(
  _transactionState: TransactionState,
  _address: string,
  _key: string,
  _isRead: boolean
): boolean {
  return true
}

function tryGetRemoteAccountCBNoOp(
  _transactionState: TransactionState,
  _type: AccountType,
  _address: string,
  _key: string
): Promise<WrappedEVMAccount> {
  return undefined
}
/* eslint-enable @typescript-eslint/no-unused-vars */

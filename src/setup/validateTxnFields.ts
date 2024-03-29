import { nestedCountersInstance, Shardus } from '@shardus/core'
import { BN, bufferToHex } from 'ethereumjs-util'
import { ShardeumFlags } from '../shardeum/shardeumFlags'
import {
  ClaimRewardTX,
  InitRewardTimes,
  InternalTx,
  InternalTXType,
  NodeAccount2,
  PenaltyTX,
  SetCertTime,
  StakeCoinsTX,
  UnstakeCoinsTX,
  WrappedEVMAccount,
} from '../shardeum/shardeumTypes'
import * as AccountsStorage from '../storage/accountStorage'
import { validateClaimRewardTx } from '../tx/claimReward'
import * as InitRewardTimesTx from '../tx/initRewardTimes'
import { isSetCertTimeTx, validateSetCertTimeTx } from '../tx/setCertTime'
import { scaleByStabilityFactor, _base16BNParser } from '../utils'
import {
  crypto,
  getInjectedOrGeneratedTimestamp,
  getTransactionObj,
  isInternalTx,
  isInternalTXGlobal,
  verify,
} from './helpers'
import { validatePenaltyTX } from '../tx/penalty/transaction'

/**
 * Checks that Transaction fields are valid
 * @param shardus
 * @param debugAppdata
 * @returns
 */
export const validateTxnFields =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (shardus: Shardus, debugAppdata: Map<string, unknown>) => (timestampedTx: any, appData: any): {
      success: boolean
      reason: string
      txnTimestamp: number
    } => {
    const { tx } = timestampedTx
    const txnTimestamp: number = getInjectedOrGeneratedTimestamp(timestampedTx)

    if (!txnTimestamp) {
      return {
        success: false,
        reason: 'Invalid transaction timestamp',
        txnTimestamp,
      }
    }

    if (isSetCertTimeTx(tx)) {
      const setCertTimeTx = tx as SetCertTime
      const result = validateSetCertTimeTx(setCertTimeTx)
      return {
        success: result.isValid,
        reason: result.reason,
        txnTimestamp,
      }
    }

    if (isInternalTx(tx)) {
      const internalTX = tx as InternalTx
      let success = false
      let reason = ''

      // validate internal TX
      if (isInternalTXGlobal(internalTX) === true) {
        return {
          success: true,
          reason: '',
          txnTimestamp,
        }
      } else if (tx.internalTXType === InternalTXType.ChangeConfig) {
        try {
          // const devPublicKey = shardus.getDevPublicKey() // This have to be reviewed again whether to get from shardus interface or not
          const devPublicKey = ShardeumFlags.devPublicKey
          if (devPublicKey) {
            success = verify(tx, devPublicKey)
            if (!success) reason = 'Dev key does not match!'
          } else {
            success = false
            reason = 'Dev key is not defined on the server!'
          }
        } catch (e) {
          reason = 'Invalid signature for internal tx'
        }
      } else if (tx.internalTXType === InternalTXType.InitRewardTimes) {
        const result = InitRewardTimesTx.validateFields(tx as InitRewardTimes, shardus)
        success = result.success
        reason = result.reason
      } else if (tx.internalTXType === InternalTXType.ClaimReward) {
        const result = validateClaimRewardTx(tx as ClaimRewardTX)
        success = result.isValid
        reason = result.reason
      } else if (tx.internalTXType === InternalTXType.Penalty) {
        const result = validatePenaltyTX(tx as PenaltyTX, shardus)
        success = result.isValid
        reason = result.reason
      } else {
        try {
          success = crypto.verifyObj(internalTX)
        } catch (e) {
          reason = 'Invalid signature for internal tx'
        }
      }
      if (ShardeumFlags.VerboseLogs) console.log('validateTxsField', success, reason)
      return {
        success,
        reason,
        txnTimestamp: txnTimestamp,
      }
    }

    // Validate EVM tx fields
    let success = false
    let reason = 'Invalid EVM transaction fields'

    try {
      const txObj = getTransactionObj(tx)
      const isSigned = txObj.isSigned()
      const isSignatureValid = txObj.validate()
      if (ShardeumFlags.VerboseLogs) console.log('validate evm tx', isSigned, isSignatureValid)

      //const txId = '0x' + crypto.hashObj(timestampedTx.tx)
      const txHash = bufferToHex(txObj.hash())

      //limit debug app data size.  (a queue would be nicer, but this is very simple)
      if (debugAppdata.size > 1000) {
        debugAppdata.clear()
      }
      debugAppdata.set(txHash, appData)

      if (isSigned && isSignatureValid) {
        success = true
        reason = ''
      } else {
        reason = 'Transaction is not signed or signature is not valid'
        nestedCountersInstance.countEvent('shardeum', 'validate - sign ' + isSigned ? 'failed' : 'missing')
      }

      if (ShardeumFlags.txBalancePreCheck && appData != null) {
        const minBalanceUsd = ShardeumFlags.chargeConstantTxFee
          ? new BN(ShardeumFlags.constantTxFeeUsd)
          : new BN(1)
        let minBalance = scaleByStabilityFactor(minBalanceUsd, AccountsStorage.cachedNetworkAccount)
        //check with value added in
        minBalance = minBalance.add(txObj.value)
        const accountBalance = new BN(appData.balance)
        if (accountBalance.lt(minBalance)) {
          success = false
          reason = `Sender does not have enough balance.`
          /* prettier-ignore */ if (ShardeumFlags.VerboseLogs) console.log(`balance fail: sender ${txObj.getSenderAddress()} does not have enough balance. Min balance: ${minBalance.toString()}, Account balance: ${accountBalance.toString()}`)
          nestedCountersInstance.countEvent('shardeum', 'validate - insufficient balance')
        } else {
          /* prettier-ignore */ if (ShardeumFlags.VerboseLogs) console.log(`balance pass: sender ${txObj.getSenderAddress()} has balance of ${accountBalance.toString()}`)
        }
      }

      if (ShardeumFlags.txNoncePreCheck && appData != null) {
        const txNonce = txObj.nonce.toNumber()
        const perfectCount = appData.nonce + appData.queueCount
        if (txNonce != perfectCount) {
          success = false
          reason = `Transaction nonce != ${perfectCount}  txNonce:${txNonce} accountNonce:${appData.nonce} queueCount:${appData.queueCount}`
          /* prettier-ignore */ if (ShardeumFlags.VerboseLogs) console.log(`nonce fail: expectedNonce:${perfectCount} != txNonce:${txNonce}.    accountNonce:${appData.nonce}  queueCount:${appData.queueCount} txHash: ${txObj.hash().toString('hex')} `)
          nestedCountersInstance.countEvent('shardeum', 'validate - nonce fail')
        } else {
          /* prettier-ignore */ if (ShardeumFlags.VerboseLogs) console.log(`nonce pass: expectedNonce:${perfectCount} == txNonce:${txNonce}.    accountNonce:${appData.nonce}  queueCount:${appData.queueCount}  txHash: ${txObj.hash().toString('hex')}`)
        }
      }

      if (appData && appData.internalTx && appData.internalTXType === InternalTXType.Stake) {
        if (ShardeumFlags.VerboseLogs) console.log('Validating stake coins tx fields', appData)
        const stakeCoinsTx = appData.internalTx as StakeCoinsTX
        const minStakeAmountUsd = _base16BNParser(appData.networkAccount.current.stakeRequiredUsd)
        const minStakeAmount = scaleByStabilityFactor(minStakeAmountUsd, AccountsStorage.cachedNetworkAccount)
        if (typeof stakeCoinsTx.stake === 'string') stakeCoinsTx.stake = new BN(stakeCoinsTx.stake, 16)
        if (
          stakeCoinsTx.nominator == null ||
          stakeCoinsTx.nominator.toLowerCase() !== txObj.getSenderAddress().toString()
        ) {
          if (ShardeumFlags.VerboseLogs)
            console.log(`nominator vs tx signer`, stakeCoinsTx.nominator, txObj.getSenderAddress().toString())
          success = false
          reason = `Invalid nominator address in stake coins tx`
        } else if (stakeCoinsTx.nominee == null) {
          success = false
          reason = `Invalid nominee address in stake coins tx`
        } else if (!/^[A-Fa-f0-9]{64}$/.test(stakeCoinsTx.nominee)) {
          //TODO: NEED to potentially write a custom faster test that avoids regex so we can avoid a regex-dos attack
          success = false
          reason = 'Invalid nominee address in stake coins tx'
        } else if (!stakeCoinsTx.stake.eq(txObj.value)) {
          if (ShardeumFlags.VerboseLogs)
            console.log(
              `Tx value and stake amount are different`,
              stakeCoinsTx.stake.toString(),
              txObj.value.toString()
            )
          success = false
          reason = `Tx value and stake amount are different`
        } else if (stakeCoinsTx.stake.lt(minStakeAmount)) {
          success = false
          reason = `Stake amount is less than minimum required stake amount`

          if (appData.nominatorAccount && ShardeumFlags.fixExtraStakeLessThanMin) {
            const wrappedEVMAccount = appData.nominatorAccount as WrappedEVMAccount
            if (wrappedEVMAccount.operatorAccountInfo) {
              const existingStake =
                typeof wrappedEVMAccount.operatorAccountInfo.stake === 'string'
                  ? new BN(wrappedEVMAccount.operatorAccountInfo.stake, 16)
                  : wrappedEVMAccount.operatorAccountInfo.stake

              if (!existingStake.isZero() && stakeCoinsTx.stake.gtn(0)) {
                success = true
                reason = ''
              }
            }
          }
        }
        if (appData.nomineeAccount) {
          const nodeAccount = appData.nomineeAccount as NodeAccount2
          if (nodeAccount.nominator && nodeAccount.nominator !== stakeCoinsTx.nominator) {
            return { success: false, reason: `This node is already staked by another account!`, txnTimestamp }
          }
        }
        if (appData.nominatorAccount) {
          const wrappedEVMAccount = appData.nominatorAccount as WrappedEVMAccount
          if (wrappedEVMAccount.operatorAccountInfo) {
            if (wrappedEVMAccount.operatorAccountInfo.nominee) {
              if (wrappedEVMAccount.operatorAccountInfo.nominee !== stakeCoinsTx.nominee)
                return {
                  success: false,
                  reason: `This account has already staked to a different node.`,
                  txnTimestamp,
                }
            }
          }
        }
      }

      if (appData && appData.internalTx && appData.internalTXType === InternalTXType.Unstake) {
        nestedCountersInstance.countEvent('shardeum-unstaking', 'validating unstake coins tx fields')
        if (ShardeumFlags.VerboseLogs) console.log('Validating unstake coins tx fields', appData.internalTx)
        const unstakeCoinsTX = appData.internalTx as UnstakeCoinsTX
        if (
          unstakeCoinsTX.nominator == null ||
          unstakeCoinsTX.nominator.toLowerCase() !== txObj.getSenderAddress().toString()
        ) {
          nestedCountersInstance.countEvent(
            'shardeum-unstaking',
            'invalid nominator address in stake coins tx'
          )
          /* prettier-ignore */ if (ShardeumFlags.VerboseLogs) console.log( `nominator vs tx signer`, unstakeCoinsTX.nominator, txObj.getSenderAddress().toString() )
          success = false
          reason = `Invalid nominator address in stake coins tx`
        } else if (unstakeCoinsTX.nominee == null) {
          nestedCountersInstance.countEvent('shardeum-unstaking', 'invalid nominee address in stake coins tx')
          success = false
          reason = `Invalid nominee address in stake coins tx`
        }
        // TODO - let unstake for a node that has never get active(rewardStartTime = 0); but this is a bit risky. need to think through again
        if (!appData.nominatorAccount) {
          success = false
          reason = `This sender account is not found!`
        } else if (appData.nomineeAccount) {
          const nodeAccount = appData.nomineeAccount as NodeAccount2
          if (!nodeAccount.nominator) {
            success = false
            reason = `No one has staked to this account!`
          } else if (_base16BNParser(nodeAccount.stakeLock).eq(new BN(0))) {
            success = false
            reason = `There is no staked amount in this node!`
          } else if (nodeAccount.nominator !== unstakeCoinsTX.nominator) {
            success = false
            reason = `This node is staked by another account. You can't unstake it!`
          } else if (shardus.isNodeActiveByPubKey(appData.nomineeAccount) === true) {
            success = false
            reason = `This node is still active in the network. You can unstake only after the node leaves the network!`
          } else if (
            nodeAccount.rewardEndTime === 0 &&
            nodeAccount.rewardStartTime > 0 &&
            !(unstakeCoinsTX.force && ShardeumFlags.allowForceUnstake)
          ) {
            //note that if both end time and start time are 0 it is ok to unstake
            success = false
            reason = `No reward endTime set, can't unstake node yet`
          }
        } else {
          success = false
          reason = `This nominee node is not found!`
        }
      }
    } catch (e) {
      if (ShardeumFlags.VerboseLogs) console.log('validate error', e)
      nestedCountersInstance.countEvent('shardeum', 'validate - exception')
      success = false
      reason = e.message
    }

    nestedCountersInstance.countEvent('shardeum', 'tx validation successful')
    return {
      success,
      reason,
      txnTimestamp,
    }
  }

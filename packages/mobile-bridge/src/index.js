'use strict'

import ZeroClientProvider from 'web3-provider-engine/zero'
import EthGasStationProvider from './EthGasStationProvider'

import initBridge from './webviewbridge'

class MobileBridge {
  constructor({ web3 }) {
    this.web3 = web3
    if (window.ReactNativeWebView) {
      initBridge()
    }
  }

  processTransaction(transaction, callback) {
    transaction.gasLimit = transaction.gas
    let onSuccess, onError
    if (callback) {
      onSuccess = result => {
        callback(undefined, result)
      }
      onError = result => {
        callback(undefined, result)
      }
    } else {
      onSuccess = result => {
        return new Promise(resolve => resolve(result))
      }
      onError = result => {
        return new Promise((resolve, reject) => reject(result))
      }
    }
    window.webViewBridge.send(
      'processTransaction',
      transaction,
      onSuccess,
      onError
    )
  }

  getAccounts(callback) {
    const data = null
    let onSuccess
    if (callback) {
      onSuccess = result => {
        callback(undefined, result)
      }
    } else {
      onSuccess = result => {
        return new Promise(resolve => resolve(result))
      }
    }
    window.webViewBridge.send('getAccounts', data, onSuccess)
  }

  signMessage(data, callback) {
    let onSuccess, onError
    if (callback) {
      onSuccess = result => {
        callback(undefined, result)
      }
      onError = result => {
        callback(undefined, result)
      }
    } else {
      onSuccess = result => {
        return new Promise(resolve => resolve(result))
      }
      onError = result => {
        return new Promise((resolve, reject) => reject(result))
      }
    }
    window.webViewBridge.send('signMessage', data, onSuccess, onError)
  }

  signPersonalMessage(data, callback) {
    let onSuccess, onError
    if (callback) {
      onSuccess = result => {
        callback(undefined, result)
      }
      onError = result => {
        callback(undefined, result)
      }
    } else {
      onSuccess = result => {
        return new Promise(resolve => resolve(result))
      }
      onError = result => {
        return new Promise((resolve, reject) => reject(result))
      }
    }
    window.webViewBridge.send('signPersonalMessage', data, onSuccess, onError)
  }

  getProvider() {
    const rpcUrl = this.web3.eth.net.currentProvider.host

    const provider = ZeroClientProvider({
      rpcUrl,
      getAccounts: this.getAccounts.bind(this),
      processTransaction: this.processTransaction.bind(this),
      signMessage: this.signMessage.bind(this),
      signPersonalMessage: this.signPersonalMessage.bind(this)
    })

    // Disable caching subProviders, because they interfere with the provider
    // we're returning.
    const providersToRemove = [
      'BlockCacheSubprovider',
      'InflightCacheSubprovider'
    ]
    provider._providers = provider._providers.filter(
      provider => !providersToRemove.includes(provider.constructor.name)
    )
    provider._providers.unshift(new EthGasStationProvider())
    provider.isOrigin = true

    return provider
  }
}

export default function MobileBridgeFunc(opts) {
  return new MobileBridge(opts)
}

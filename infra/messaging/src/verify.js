'use strict'

const logger = require('./logger')
const Web3Utils = require('web3-utils')
const Eth = require('web3-eth')
const config = require('./config')
const fetch = require('cross-fetch')
const stringify = require('json-stable-stringify')

const Web3Eth = new Eth()

/**
 * Returns the ID of the room between two conversations
 * Sorts the address before concating so that there is no duplicate rooms
 * between two addresses, i.e. joinConversationKey(x, y) === joinConversationKey(y, x)
 * @param {Address} converser1
 * @param {Address} converser2
 * @returns {String}
 */
function joinConversationKey(converser1, converser2) {
  return [converser1, converser2].sort().join('-')
}

function verifyConversationSignature(keysMap) {
  return (signature, key, message, buffer) => {
    const verifyAddress = Web3Eth.accounts.recover(
      buffer.toString('utf8'),
      signature
    )
    // Hopefully the last 42 is the eth address
    const ethAddress = message.id.substr(-42)
    // Only one of the two conversers can set this parameter
    if (key == message.payload.key || key == ethAddress) {
      const entry = keysMap.get(key)
      return entry.address == verifyAddress
    }
    return false
  }
}

function verifyConversers(conversee, keysMap) {
  return (o, contentObject) => {
    const checkString =
      joinConversationKey(conversee, o.parentSub) + contentObject.ts.toString()
    const verifyAddress = Web3Eth.accounts.recover(
      checkString,
      contentObject.sig
    )
    const parentKey = keysMap.get(o.parentSub)
    const converseeKey = keysMap.get(conversee)

    if (
      (parentKey && verifyAddress == parentKey.address) ||
      (converseeKey && verifyAddress == keysMap.get(conversee).address)
    ) {
      logger.debug(
        `Verified conv init for ${conversee}, Signature: ${contentObject.sign}, Signed with: ${verifyAddress}`
      )
      return true
    }
    return false
  }
}

function verifyNewMessageSignature(
  signature,
  conversationId,
  conversationIndex,
  content,
  address
) {
  const buffer = stringify({ conversationId, conversationIndex, content })
  const recoveredAddress = Web3Eth.accounts.recover(buffer, signature)
  console.log(
    'recovered buffer:',
    buffer,
    ' raddress:',
    recoveredAddress,
    ' address:',
    address
  )
  return recoveredAddress === address
}

function verifyMessageSignature(keysMap, orbitGlobal) {
  return (signature, key, message, buffer) => {
    logger.debug(
      `Verify message: ${message.id}, Key: ${key}, Signature: ${signature}`
    )

    const verifyAddress = Web3Eth.accounts.recover(
      buffer.toString('utf8'),
      signature
    )
    const entry = keysMap.get(key)

    const dbStore = orbitGlobal.stores[message.id]
    if (
      config.LINKING_NOTIFY_ENDPOINT &&
      dbStore &&
      dbStore.__snapshot_loaded &&
      dbStore.access.write.includes(key)
    ) {
      const value = message.payload.value
      if (value.length && value[0].emsg) {
        const receivers = dbStore.access.write
          .filter(address => address != key)
          .reduce((acc, i) => {
            acc[i] = { newMessage: true }
            return acc
          }, {})

        fetch(config.LINKING_NOTIFY_ENDPOINT, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            receivers,
            token: config.LINKING_NOTIFY_TOKEN
          })
        })
      }
    }

    //only two addresses should have write access to here
    return entry.address == verifyAddress
  }
}

/**
 * Verifies registry signature
 * @param {String} signature
 * @param {String} message.payload.key User's public ethereum address
 * @param {String} message.payload.value The data that was signed
 * @return {Boolean} true if `message.payload.value` was signed by `message.payload.key`; false otherwise
 */
function verifyRegistrySignature(signature, message) {
  const value = message.payload.value
  const setKey = message.payload.key
  const verifyAddress = Web3Eth.accounts.recover(value.msg, signature)

  if (verifyAddress === setKey && value.msg.includes(value.address)) {
    const extractedAddress = '0x' + Web3Utils.sha3(value.pub_key).substr(-40)

    if (extractedAddress == value.address.toLowerCase()) {
      const verifyPhAddress = Web3Eth.accounts.recover(value.ph, value.phs)
      if (verifyPhAddress == value.address) {
        logger.debug(
          `Key verified: ${value.msg}, Signature: ${signature}, Signed with, ${verifyAddress}`
        )
        return true
      }
    }
  }
  logger.error('Key verify failed...')
  return false
}

module.exports = {
  verifyConversationSignature,
  verifyConversers,
  verifyMessageSignature,
  verifyRegistrySignature,
  verifyNewMessageSignature
}

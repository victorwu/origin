require('dotenv').config()
const config = require('./config')

const WebSocket = require('ws')
const openpgp = require('openpgp')
const Web3 = require('web3')
const get = require('lodash/get')

const { Network, Shops, Transactions, Orders } = require('./data/db')
const abi = require('./utils/_abi')
const {
  getIpfsHashFromBytes32,
  getText,
  getIPFSGateway
} = require('./utils/_ipfs')
const encConf = require('./utils/encryptedConfig')
const { NETWORK_ID } = require('./utils/const')
const { ListingID, OfferID } = require('./utils/id')
const { addressToVersion } = require('./utils/address')

const sendMail = require('./utils/emailer')

const web3 = new Web3()

const Marketplace = new web3.eth.Contract(abi)
const MarketplaceABI = Marketplace._jsonInterface
/*const localContract = process.env.MARKETPLACE_CONTRACT
const PrivateKey = process.env.PGP_PRIVATE_KEY.startsWith('--')
  ? process.env.PGP_PRIVATE_KEY
  : Buffer.from(process.env.PGP_PRIVATE_KEY, 'base64').toString('ascii')
const PrivateKeyPass = process.env.PGP_PRIVATE_KEY_PASS*/

/*
const SubscribeToLogs = address =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_subscribe',
    params: ['logs', { address, topics: [] }]
  })*/

const SubscribeToNewHeads = JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  method: 'eth_subscribe',
  params: ['newHeads']
})

const GetPastLogs = ({ fromBlock, toBlock, listingId }) => {
  if (!listingId || !(listingId instanceof Array)) {
    listingId = [listingId]
  }

  const params = listingId.map(lid => {
    const listingTopic = web3.utils.padLeft(
      web3.utils.numberToHex(lid.listingId),
      64
    )
    return {
      address: lid.address(),
      topics: [null, null, listingTopic],
      fromBlock: web3.utils.numberToHex(fromBlock),
      toBlock: web3.utils.numberToHex(toBlock)
    }
  })

  const rpc = {
    jsonrpc: '2.0',
    id: 3,
    method: 'eth_getLogs',
    params
  }
  return JSON.stringify(rpc)
}
const netId = NETWORK_ID
let ws
async function connectWS() {
  let lastBlock

  web3.setProvider(config.provider)

  console.log(`Connecting to ${config.provider} (netId ${netId})`)

  try {
    const res = await Network.findOne({ where: { network_id: netId } })
    if (res) {
      lastBlock = res.last_block
      console.log(`Last recorded block: ${lastBlock}`)
    } else {
      console.log('No recorded block found')
    }
  } catch (err) {
    console.error('Error looking up network')
    console.error(err)
  }

  if (ws) {
    ws.removeAllListeners()
  }

  console.log('Trying to connect...')
  ws = new WebSocket(config.provider)

  function heartbeat() {
    console.log('Got ping...')
    clearTimeout(this.pingTimeout)
    this.pingTimeout = setTimeout(() => {
      console.log('ping timeout')
      ws.terminate()
      connectWS()
    }, 30000 + 1000)
  }
  ws.heartbeat = heartbeat

  ws.on('error', err => {
    console.log('Error')
    console.error(err)
    setTimeout(() => connectWS(), 5000)
  })
  ws.on('ping', heartbeat)
  ws.on('close', function clear() {
    console.log('Connection closed')
    clearTimeout(this.pingTimeout)
  })

  ws.on('open', function open() {
    console.log('Connection open')
    this.heartbeat()
    // TODO: Why eth_subscribe (logs on address) AND eth_getLogs?
    //ws.send(SubscribeToLogs(siteConfig.marketplaceContract || localContract, listingId))
    ws.send(SubscribeToNewHeads)
  })

  const handled = {}
  let heads, logs
  ws.on('message', function incoming(raw) {
    const hash = web3.utils.sha3(raw)
    if (handled[hash]) {
      console.log('Ignoring repeated ws message')
    }
    handled[hash] = true

    const data = JSON.parse(raw)
    if (data.id === 1) {
      logs = data.result
    } else if (data.id === 2) {
      heads = data.result
    } else if (data.id === 3) {
      if (data.result) {
        console.log(`Got ${data.result.length} unhandled logs`)
        data.result.map(handleLog)
      } else {
        console.error('Unknown response format for eth_getLogs: ', data)
      }
    } else if (get(data, 'params.subscription') === logs) {
      handleLog(data.params.result)
    } else if (get(data, 'params.subscription') === heads) {
      const number = handleNewHead(data.params.result)
      const blockDiff = number - lastBlock
      if (blockDiff > 500) {
        console.log('Too many new blocks. Skip past log fetch.')
      } else if (blockDiff >= 1) {
        // Removed config.fetchPastLogs because that's not a thing
        Shops.findAll({
          attributes: ['listing_id']
        })
          .then(rows => {
            const listingId = rows.map(row => {
              return ListingID.fromFQLID(row.listing_id)
            })
            console.log(
              `Fetching ${blockDiff} past blocks of logs for ${listingId.length} listings...`
            )
            // TODO: At what point does the amount of params make this query difficult?
            ws.send(
              GetPastLogs({ fromBlock: lastBlock, toBlock: number, listingId })
            )
          })
          .catch(err => {
            console.error(err)
          })
      }
      lastBlock = number
    } else {
      console.log('Unknown message')
    }
  })
}

const handleNewHead = head => {
  const number = web3.utils.hexToNumber(head.number)
  const timestamp = web3.utils.hexToNumber(head.timestamp)
  console.log(`New block ${number} timestamp: ${timestamp}`)

  Network.upsert({ network_id: netId, last_block: number })

  return number
}

const handleLog = async ({
  data,
  topics,
  transactionHash,
  address,
  blockNumber
}) => {
  const ipfsGateway = await getIPFSGateway()
  const eventAbi = MarketplaceABI.find(i => i.signature === topics[0])
  if (!eventAbi) {
    console.log('Unknown event')
    return
  }
  console.log('fetch existing...', transactionHash)
  const existingTx = await Transactions.findOne({
    where: { transaction_hash: transactionHash }
  })
  console.log('existing', existingTx)
  if (existingTx) {
    console.log('Already handled tx')
    return
  } else {
    Transactions.create({
      network_id: netId,
      transaction_hash: transactionHash,
      block_number: web3.utils.hexToNumber(blockNumber)
    }).then(res => {
      console.log(`Created tx ${res.dataValues.id}`)
    })
  }

  const { name, inputs } = eventAbi
  const decoded = web3.eth.abi.decodeLog(inputs, data, topics.slice(1))
  const { listingID, offerID, ipfsHash, party } = decoded

  const contractVersion = addressToVersion(address)
  const lid = new ListingID(listingID, NETWORK_ID, contractVersion)
  const oid = new OfferID(listingID, offerID, NETWORK_ID, contractVersion)

  console.log(`${name} - ${oid.toString()} by ${party}`)
  console.log(`IPFS Hash: ${getIpfsHashFromBytes32(ipfsHash)}`)

  try {
    const offerData = await getText(ipfsGateway, ipfsHash, 10000)
    const offer = JSON.parse(offerData)
    console.log('Offer:', offer)

    if (!offer.encryptedData) {
      console.log('No encrypted data found')
      return
    }

    const record = await Shops.findOne({
      where: {
        listing_id: lid.toString()
      }
    })
    const shopId = record.id

    const encryptedDataJson = await getText(
      ipfsGateway,
      offer.encryptedData,
      10000
    )
    const encryptedData = JSON.parse(encryptedDataJson)
    console.log('Encrypted Data:', encryptedData)

    const PrivateKey = await encConf.get(shopId, 'pgp_private_key')
    const PrivateKeyPass = await encConf.get(shopId, 'pgp_private_key_pass')

    if (!PrivateKey) {
      console.error(`Missing private key for shop ${shopId}. Unable to process event!`)
      return
    }
    if (!PrivateKeyPass) {
      console.warn(`Missing private key decryption passphrase for shop ${shopId}. This will probably fail!`)
    }

    const privateKey = await openpgp.key.readArmored(PrivateKey)

    if (!privateKey || !privateKey.keys || privateKey.keys.length < 1) {
      if (privateKey.err) {
        for (const err of privateKey.err) {
          console.error(err)
        }
      }
      console.error(`Unable to load private key for shop ${shopId}. Unable to process event!`)
      return
    }

    const privateKeyObj = privateKey.keys[0]
    await privateKeyObj.decrypt(PrivateKeyPass)

    const message = await openpgp.message.readArmored(encryptedData.data)
    const options = { message, privateKeys: [privateKeyObj] }

    const plaintext = await openpgp.decrypt(options)
    const cart = JSON.parse(plaintext.data)
    cart.offerId = oid.toString()
    cart.tx = transactionHash

    console.log(cart)

    Orders.create({
      order_id: cart.offerId,
      shop_id: shopId,
      network_id: netId,
      data: JSON.stringify(cart)
    }).then(() => {
      console.log('Saved to DB OK')
    })

    sendMail(shopId, cart)
  } catch (e) {
    console.error(e)
  }
}

connectWS()

const ListingsRegistryStorage = artifacts.require(
  "./ListingsRegistryStorage.sol"
)
const contractDefinition = artifacts.require("./ListingsRegistry.sol")

const initialListingsLength = 0
const ipfsHash =
  "0x6b14cac30356789cd0c39fec0acc2176c3573abdb799f3b17ccc6972ab4d39ba"

// Used to assert error cases
const isEVMError = function(err) {
  let str = err.toString()
  return str.includes("revert")
}

contract("ListingsRegistry", accounts => {
  var owner = accounts[0]
  var notOwner = accounts[1]
  var instance
  var listingsRegistryStorage

  beforeEach(async function() {
    listingsRegistryStorage = await ListingsRegistryStorage.new({ from: owner })
    instance = await contractDefinition.new(listingsRegistryStorage.address, {
      from: owner
    })
    listingsRegistryStorage.setActiveRegistry(instance.address)
  })

  it("should have owner as owner of contract", async function() {
    let contractOwner = await instance.owner()
    assert.equal(contractOwner, owner)
  })

  it("should be able to create a listing", async function() {
    const initPrice = 2
    const initUnitsAvailable = 5
    await instance.create(ipfsHash, initPrice, initUnitsAvailable, {
      from: accounts[0]
    })
    let listingCount = await instance.listingsLength()
    assert.equal(
      listingCount,
      initialListingsLength + 1,
      "listings count has incremented"
    )
    let [
      listingAddress,
      lister,
      hash,
      price,
      unitsAvailable
    ] = await instance.getListing(initialListingsLength)
    assert.equal(lister, accounts[0], "lister is correct")
    assert.equal(hash, ipfsHash, "ipfsHash is correct")
    assert.equal(price, initPrice, "price is correct")
    assert.equal(
      unitsAvailable,
      initUnitsAvailable,
      "unitsAvailable is correct"
    )
  })

  it("should be able to create a listing on behalf of other", async function() {
    const initPrice = 2
    const initUnitsAvailable = 5
    await instance.createOnBehalf(
      ipfsHash,
      initPrice,
      initUnitsAvailable,
      accounts[1],
      { from: accounts[0] }
    )
    let listingCount = await instance.listingsLength()
    assert.equal(
      listingCount,
      initialListingsLength + 1,
      "listings count has incremented"
    )
    let [
      listingAddress,
      lister,
      hash,
      price,
      unitsAvailable
    ] = await instance.getListing(initialListingsLength)
    assert.equal(lister, accounts[1], "lister is correct as other account")
    assert.equal(hash, ipfsHash, "ipfsHash is correct")
    assert.equal(price, initPrice, "price is correct")
    assert.equal(
      unitsAvailable,
      initUnitsAvailable,
      "unitsAvailable is correct"
    )
  })
})

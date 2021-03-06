import React, { useState } from 'react'
import { useRouteMatch } from 'react-router-dom'
import get from 'lodash/get'

import useOrder from 'utils/useOrder'
import useConfig from 'utils/useConfig'
import usePrintfulIds from 'utils/usePrintfulIds'
import usePrintful from 'utils/usePrintful'
import { Countries } from 'data/Countries'

const { BACKEND_AUTH_TOKEN } = process.env

function generatePrintfulOrder(order, printfulIds) {
  const data = order.data

  const printfulData = {
    external_id: order.orderId,
    recipient: {
      name: `${data.userInfo.firstName} ${data.userInfo.lastName}`,
      address1: data.userInfo.address1,
      city: data.userInfo.city,
      state_name: data.userInfo.province,
      state_code: get(
        Countries,
        `[${data.userInfo.country}].provinces[${data.userInfo.province}].code`
      ),
      country_name: data.userInfo.country,
      country_code: get(Countries, `[${data.userInfo.country}].code`),
      zip: data.userInfo.zip
    },
    items: data.items.map(item => ({
      sync_variant_id: get(printfulIds, `[${item.product}][${item.variant}]`),
      quantity: item.quantity
    })),

    costs: {
      subtotal: (data.subTotal / 100).toFixed(2),
      discount: (data.discount / 100).toFixed(2),
      shipping: (data.shipping.amount / 100).toFixed(2),
      tax: '0.00',
      total: (data.total / 100).toFixed(2)
    }
  }
  return printfulData
}

const Printful = () => {
  const { config } = useConfig()
  const [create, setCreate] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const match = useRouteMatch('/admin/orders/:orderId/:tab?')
  const { orderId } = match.params
  const { order, loading } = useOrder(orderId)
  const { printfulIds } = usePrintfulIds()
  const printfulOrder = usePrintful(orderId)

  if (loading) {
    return <div>Loading...</div>
  }
  if (!order) {
    return <div>Order not found</div>
  }

  const printfulData = generatePrintfulOrder(order, printfulIds)

  if (printfulOrder) {
    return (
      <div>
        {printfulOrder.status !== 'draft' ? null : (
          <button
            className={`btn btn-primary${confirm ? ' disabled' : ''}`}
            onClick={async () => {
              if (confirm) {
                return
              }
              setConfirm(true)
              const headers = new Headers({
                authorization: `bearer ${BACKEND_AUTH_TOKEN}`,
                'content-type': 'application/json'
              })
              const myRequest = new Request(
                `${config.backend}/orders/${orderId}/printful/confirm`,
                {
                  headers,
                  credentials: 'include',
                  method: 'POST'
                }
              )
              const raw = await fetch(myRequest)
              const json = await raw.json()
              console.log(json)
            }}
          >
            Confirm Order
          </button>
        )}
        <pre>{JSON.stringify(printfulOrder, null, 2)}</pre>
      </div>
    )
  }

  return (
    <div>
      <pre>{JSON.stringify(printfulData, null, 2)}</pre>
      <button
        className={`btn btn-primary${create ? ' disabled' : ''}`}
        onClick={async () => {
          if (create) {
            return
          }
          setCreate(true)
          const headers = new Headers({
            authorization: `bearer ${BACKEND_AUTH_TOKEN}`,
            'content-type': 'application/json'
          })
          const myRequest = new Request(
            `${config.backend}/orders/${orderId}/printful/create`,
            {
              headers,
              credentials: 'include',
              method: 'POST',
              body: JSON.stringify(printfulData)
            }
          )
          const raw = await fetch(myRequest)
          const json = await raw.json()
          console.log(json)
        }}
      >
        Create Order
      </button>
    </div>
  )
}

export default Printful

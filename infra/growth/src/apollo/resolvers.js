const {
  AuthenticationError,
  ForbiddenError,
  UserInputError
} = require('apollo-server')
const { GraphQLDateTime } = require('graphql-iso-date')

const { GrowthCampaign } = require('../resources/campaign')
const {
  authenticateEnrollment,
  getUserAuthenticationStatus
} = require('../resources/authentication')
const {
  getLocationInfo,
  getLocationEligibilityInfo
} = require('../util/locationInfo')
const { campaignToApolloObject } = require('./adapter')
const { GrowthInvite } = require('../resources/invite')
const { sendInvites, sendInviteReminder } = require('../resources/email')
const enums = require('../enums')
const logger = require('../logger')
const { BannedUserError } = require('../util/bannedUserError')
const { GrowthEvent } = require('@origin/growth-shared/src/resources/event')

const requireEnrolledUser = context => {
  if (
    context.authentication !==
    enums.GrowthParticipantAuthenticationStatus.Enrolled
  ) {
    throw new Error('User not authenticated!')
  }
}

// Resolvers define the technique for fetching the types in the schema.
const resolvers = {
  /* TODO:
   * Use this pagination helpers when implementing pagination:
   * https://github.com/OriginProtocol/origin/blob/master/packages/graphql/src/resolvers/_pagination.js
   */
  DateTime: GraphQLDateTime,
  GrowthBaseAction: {
    __resolveType(action) {
      switch (action.type) {
        case 'Referral':
          return 'ReferralAction'
        case 'ListingIdPurchased':
          return 'ListingIdPurchasedAction'
        case 'TwitterShare':
          return 'SocialShareAction'
        case 'FacebookShare':
          return 'SocialShareAction'
        default:
          return 'GrowthAction'
      }
    }
  },
  Query: {
    async campaigns(_, args, context) {
      const campaigns = await GrowthCampaign.getAll()

      return {
        totalCount: campaigns.length,
        nodes: campaigns.map(
          async campaign =>
            await campaignToApolloObject(
              campaign,
              context.authentication,
              context.walletAddress
            )
        ),
        pageInfo: {
          endCursor: 'TODO implement',
          hasNextPage: false,
          hasPreviousPage: false,
          startCursor: 'TODO implement'
        }
      }
    },
    async campaign(root, args, context) {
      let campaign
      if (args.id === 'active') {
        campaign = await GrowthCampaign.getActive()
      } else {
        campaign = await GrowthCampaign.get(args.id)
      }

      if (!campaign) {
        throw new UserInputError('Invalid campaign id', { id: args.id })
      }

      return await campaignToApolloObject(
        campaign,
        context.authentication,
        context.walletAddress
      )
    },
    async inviteInfo(root, args) {
      try {
        return await GrowthInvite.getReferrerInfo(args.code)
      } catch (e) {
        throw new UserInputError('Invalid code', { code: args.code })
      }
    },
    async inviteCode(root, args, context) {
      requireEnrolledUser(context)
      return await GrowthInvite.getInviteCode(context.walletAddress)
    },
    async isEligible(obj, args, context) {
      let eligibility
      if (process.env.NODE_ENV !== 'production') {
        // In non production environment, always return eligible.
        eligibility = {
          eligibility: 'Eligible',
          countryName: 'N/A',
          countryCode: 'N/A'
        }
      } else {
        // Geolocalize based on IP and check eligibility.
        eligibility = await getLocationEligibilityInfo(
          context.req.headers['x-real-ip']
        )
      }
      logger.debug('Eligibility:', JSON.stringify(eligibility))
      return eligibility
    },
    async enrollmentStatus(_, args, context) {
      // if identity is overridden with admin_secret always show as enrolled
      if (context.identityOverriden) {
        return enums.GrowthParticipantAuthenticationStatus.Enrolled
      } else {
        /* otherwise we need to query the enrolment status again to match the current
         * walletAddress and authentication token. In case user switches the wallet account
         * an otherwise valid authentication token needs to be invalidated.
         */
        return await getUserAuthenticationStatus(
          context.authToken,
          args.walletAddress
        )
      }
    },
    async telegramGroupName(obj, args, context) {
      const locationInfo = await getLocationInfo(
        context.req.headers['x-real-ip']
      )

      if (!locationInfo) {
        return 'originprotocol'
      }

      return locationInfo.countryCode === 'KR'
        ? 'originprotocolkorea'
        : 'originprotocol'
    }
  },
  Mutation: {
    // Sends email invites with referral code on behalf of the referrer.
    async invite(_, args, context) {
      requireEnrolledUser(context)

      logger.info('invite mutation called.')
      // FIXME: implement rate limiting to avoid spam attack.
      await sendInvites(context.walletAddress, args.emails)
      return true
    },
    async enroll(_, args, context) {
      let ip, eligibility, countryCode
      if (process.env.NODE_ENV !== 'production') {
        ip = '192.168.1.1'
        eligibility = 'Eligible'
        countryCode = 'NA'
      } else {
        ip = context.req.headers['x-real-ip']
        const locationInfo = await getLocationEligibilityInfo(ip)
        eligibility = locationInfo.eligibility
        countryCode = locationInfo.countryCode
      }

      if (eligibility === 'Forbidden') {
        logger.warn('Enrollment declined for user in country ', countryCode)
        throw new ForbiddenError('Forbidden country')
      }

      try {
        const authToken = await authenticateEnrollment(
          context.walletAddress,
          args.agreementMessage,
          args.fingerprintData,
          ip,
          countryCode
        )

        /* Make referral connection after we are sure user provided the correct accountId
         *
         * Important to keep in mind: We realise making a referral connection inside enroll mutation
         * has a downside where a referrer gets the reward only when the referee also enrolls into
         * the growth campaign.
         *
         * We have decided to take this approach in favour of making the referral connection as soon
         * as the user satisfy both conditions:
         * - enters Welcome page with invite code
         * - has a wallet installed
         * as the above approach happens before a user is authenticated and this leaves us exposed
         * to situations where bad actors could make false referral connections to their own campaigns.
         */
        if (args.inviteCode) {
          await GrowthInvite.makeReferralConnection(
            args.inviteCode,
            context.walletAddress
          )
        }

        return {
          authToken,
          isBanned: false
        }
      } catch (e) {
        if (e instanceof BannedUserError) {
          return {
            authToken: '',
            isBanned: true
          }
        } else {
          logger.warn('User authentication failed: ', e.message, e.stack)
          throw new AuthenticationError('Growth authentication failure')
        }
      }
    },
    async inviteRemind(_, args, context) {
      requireEnrolledUser(context)

      sendInviteReminder(context.walletAddress, args.invitationId)
      return true
    },
    async logSocialShare(_, args, context) {
      requireEnrolledUser(context)
      if (args.actionType === enums.GrowthActionType.FacebookShare) {
        await GrowthEvent.insert(
          logger,
          1,
          context.walletAddress.toLowerCase(), //ethAddress
          enums.GrowthEventTypes.SharedOnFacebook,
          args.contentId, //customId
          null,
          new Date()
        )
        return true
      }

      // track growth events only for supported platforms
      logger.warn(
        `Not supported actionType: ${args.actionType} for social share`
      )
      return false
    },
    async logSocialFollow(_, args, context) {
      requireEnrolledUser(context)
      if (args.actionType === enums.GrowthActionType.FacebookLike) {
        await GrowthEvent.insert(
          logger,
          1,
          context.walletAddress.toLowerCase(), //ethAddress
          enums.GrowthEventTypes.LikedOnFacebook,
          null,
          null,
          new Date()
        )
        return true
      }

      // track growth events only for supported platforms
      logger.warn(
        `Not supported actionType: ${args.actionType} for social follow`
      )
      return false
    },
    log() {
      // TODO: implement
      logger.info('log mutation called.')
      return true
    }
  }
}

module.exports = resolvers

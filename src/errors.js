export class ClientError extends Error {
  constructor(message, props = {}) {
    const text = props.message ?? message
    super(
      text || `${props.reason ?? 'Unknown'} (${props.error_type ?? JSON.stringify(props)})`
    )
    this.name = new.target.name
    Object.assign(this, props)
    this.message = this.message || ''
    this.response = props.response ?? null
    this.code = this.response?.status ?? props.code ?? null
  }
}

export class ClientUnknownError extends ClientError {}
export class WrongCursorError extends ClientError {}
export class ClientStatusFail extends ClientError {}
export class ClientErrorWithTitle extends ClientError {}
export class ResetPasswordError extends ClientError {}
export class GenericRequestError extends ClientError {}
export class ClientGraphqlError extends ClientError {}
export class ClientJSONDecodeError extends ClientError {}
export class ClientConnectionError extends ClientError {}
export class ClientBadRequestError extends ClientError {}
export class ClientUnauthorizedError extends ClientError {}
export class ClientForbiddenError extends ClientError {}
export class ClientNotFoundError extends ClientError {}
export class ClientThrottledError extends ClientError {}
export class ClientRequestTimeout extends ClientError {}
export class ClientIncompleteReadError extends ClientError {}
export class ClientLoginRequired extends ClientError {}
export class ReloginAttemptExceeded extends ClientError {}
export class AccountSuspended extends ClientError {}
export class ValidationError extends Error {}
export class EmailInvalidError extends ClientError {}
export class EmailNotAvailableError extends ClientError {}
export class EmailVerificationSendError extends ClientError {}
export class AgeEligibilityError extends ClientError {}
export class CaptchaChallengeRequired extends ClientError {}
export class RelatedProfileRequired extends ClientError {}

export class PrivateError extends ClientError {}
export class NotFoundError extends PrivateError {}
export class FeedbackRequired extends PrivateError {}
export class SignupSpamError extends FeedbackRequired {}
export class ChallengeError extends PrivateError {}
export class ChallengeRedirection extends ChallengeError {}
export class ChallengeRequired extends ChallengeError {}
export class ChallengeSelfieCaptcha extends ChallengeError {}
export class ChallengeUnknownStep extends ChallengeError {}
export class SelectContactPointRecoveryForm extends ChallengeError {}
export class RecaptchaChallengeForm extends ChallengeError {}
export class SubmitPhoneNumberForm extends ChallengeError {}
export class LegacyForceSetNewPasswordForm extends ChallengeError {}
export class LoginRequired extends PrivateError {}
export class SentryBlock extends PrivateError {}
export class RateLimitError extends PrivateError {}
export class ProxyAddressIsBlocked extends PrivateError {}
export class BadPassword extends PrivateError {}
export class BadCredentials extends PrivateError {}
export class PleaseWaitFewMinutes extends PrivateError {}
export class UnknownError extends PrivateError {}
export class ClientNeedsUpgradeError extends UnknownError {}
export class AccountEditError extends PrivateError {}
export class AccountContactPointRequired extends AccountEditError {}
export class TrackNotFound extends NotFoundError {}
export class MediaError extends PrivateError {}
export class MediaNotFound extends NotFoundError {}
export class StoryNotFound extends NotFoundError {}
export class UserError extends PrivateError {}
export class UserNotFound extends NotFoundError {}
export class CollectionError extends PrivateError {}
export class CollectionNotFound extends NotFoundError {}
export class DirectError extends PrivateError {}
export class DirectThreadNotFound extends NotFoundError {}
export class DirectMessageNotFound extends NotFoundError {}
export class DirectMessageRequestsDisabled extends DirectError {}
export class VideoTooLongException extends PrivateError {}
export class VideoNotDownload extends PrivateError {}
export class VideoNotUpload extends PrivateError {}
export class VideoConfigureError extends VideoNotUpload {}
export class PhotoNotUpload extends PrivateError {}
export class PhotoConfigureError extends PhotoNotUpload {}
export class AlbumNotDownload extends PrivateError {}
export class AlbumUnknownFormat extends PrivateError {}
export class AlbumConfigureError extends PrivateError {}
export class HashtagError extends PrivateError {}
export class HashtagNotFound extends NotFoundError {}
export class LocationError extends PrivateError {}
export class LocationNotFound extends NotFoundError {}
export class TwoFactorRequired extends PrivateError {}
export class HighlightNotFound extends NotFoundError {}
export class NoteNotFound extends NotFoundError {}
export class PrivateAccount extends PrivateError {}
export class InvalidTargetUser extends PrivateError {}
export class InvalidMediaId extends PrivateError {}
export class MediaUnavailable extends PrivateError {}
export class CommentUnavailable extends PrivateError {}
export class CommentNotFound extends PrivateError {}
export class CommentsDisabled extends PrivateError {}

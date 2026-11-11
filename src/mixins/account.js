import { ValidationError } from '../errors.js'
import { extractAccount } from '../extractors.js'
import { dumps } from '../utils.js'

const EDITABLE_FIELDS = ['external_url', 'username', 'full_name', 'biography', 'phone_number', 'email']

export const accountMixin = {
  async accountInfo() {
    const result = await this.privateRequest('accounts/current_user/?edit=true')
    return extractAccount(result.user)
  },

  async accountEdit(fields = {}) {
    let data = Object.fromEntries(Object.entries(fields).filter(([key]) => EDITABLE_FIELDS.includes(key)))
    if (!('email' in data) || !('phone_number' in data)) {
      const current = await this.accountInfo()
      const base = Object.fromEntries(EDITABLE_FIELDS.map((key) => [key, current[key]]))
      data = { ...base, ...data }
    }
    const fullName = data.full_name
    delete data.full_name
    if (fullName) data.first_name = fullName
    const result = await this.privateRequest('accounts/edit_profile/', this.withDefaultData(data))
    if (data.biography) await this.accountSetBiography(data.biography)
    return extractAccount(result.user)
  },

  async accountSetBiography(biography) {
    const data = { logged_in_uids: dumps([String(this.userId)]), raw_text: biography }
    const result = await this.privateRequest('accounts/set_biography/', this.withDefaultData(data))
    return result.status === 'ok'
  },

  async accountSecurityInfo() {
    return this.privateRequest('accounts/account_security_info/', this.withDefaultData({}))
  },

  async accountSetPrivate() {
    if (!this.userId) throw new ValidationError('Login required')
    const data = this.withActionData({ _uid: String(this.userId), _uuid: this.uuid })
    const result = await this.privateRequest('accounts/set_private/', data)
    return result.status === 'ok'
  },

  async accountSetPublic() {
    if (!this.userId) throw new ValidationError('Login required')
    const data = this.withActionData({ _uid: String(this.userId), _uuid: this.uuid })
    const result = await this.privateRequest('accounts/set_public/', data)
    return result.status === 'ok'
  }
}

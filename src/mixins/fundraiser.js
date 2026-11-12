export const fundraiserMixin = {
  async standaloneFundraiserInfoV1(userId) {
    return this.privateRequest(`fundraiser/${String(userId)}/standalone_fundraiser_info/`)
  }
}

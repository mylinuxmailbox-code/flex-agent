export interface Skill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly keywords: readonly string[]
  readonly guidance: string
}

export interface SkillMatch {
  skill: Skill
  score: number
}

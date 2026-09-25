import { BUILTIN_SKILLS } from './builtins/index.js'
import type { Skill } from './types.js'

export class SkillRegistry {
  private skills = new Map<string, Skill>()

  constructor() {
    for (const skill of BUILTIN_SKILLS) {
      this.skills.set(skill.id, skill)
    }
  }

  register(skill: Skill): void {
    this.skills.set(skill.id, skill)
  }

  get(id: string): Skill | undefined {
    return this.skills.get(id)
  }

  all(): readonly Skill[] {
    return Array.from(this.skills.values())
  }

  /**
   * Find skills that match the user request.
   * Only activates relevant skills so context remains compact.
   */
  findRelevant(text: string, maxSkills = 2): Skill[] {
    const lower = text.toLowerCase()
    const scored: Array<{ skill: Skill; score: number }> = []

    for (const skill of this.skills.values()) {
      let score = 0
      for (const kw of skill.keywords) {
        if (lower.includes(kw.toLowerCase())) {
          score += 1
        }
      }
      if (score > 0) {
        scored.push({ skill, score })
      }
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, maxSkills).map((s) => s.skill)
  }

  formatPromptGuidance(skills: readonly Skill[]): string {
    if (skills.length === 0) return ''
    const blocks = skills.map((s) => `### ${s.name}\n${s.guidance}`)
    return `## Active Skills\n\n${blocks.join('\n\n')}`
  }
}

export const skillRegistry = new SkillRegistry()

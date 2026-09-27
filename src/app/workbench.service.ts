import { Injectable, OnDestroy } from '@angular/core'
import { BehaviorSubject, map, type Observable } from 'rxjs'
import type { Annotation, Claim, ClaimVersion, Feature, Paragraph, Position, ReviewLine, ReviewMatchKind, Role, ValidationIssue, WorkbenchState } from './models'

const STORAGE_KEY = 'patent-claim-mapping-workbench-v1'
const POSITION_KEY = 'patent-claim-mapping-position-v1'

type CommitScope = 'shared' | Role

interface HistoryEntry {
  state: WorkbenchState
  scope: CommitScope
}

export interface ReviewPreviewRow {
  line: number
  ref: string
  comment: string
  matchKind: ReviewMatchKind
  featureId: string | null
  candidateIds: string[]
  duplicateAnnotationId: string | null
  invalid: boolean
}

export interface ImportReviewResult {
  imported: number
  annotated: number
  duplicate: number
  pending: number
}

interface ParsedRef {
  claimNumber: number | null
  code: string
}

const initialClaims: Claim[] = [
  { id: 'claim-1', number: 1, title: '一种自适应展柜环境控制装置', independent: true, text: '一种自适应展柜环境控制装置，包括：柜体；环境传感模块，设置于所述柜体内并用于采集温湿度数据；以及控制模块，与所述环境传感模块通信，并根据所述温湿度数据调节所述柜体的微环境。' },
  { id: 'claim-2', number: 2, title: '传感模块的布置方式', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述环境传感模块包括沿所述柜体对角线布置的多个温湿度传感器。' },
  { id: 'claim-3', number: 3, title: '控制模块的调节策略', independent: false, text: '根据权利要求1所述的装置，其特征在于，所述控制模块基于历史数据与当前数据之间的偏差分级调节除湿单元。' }
]
const initialParagraphs: Paragraph[] = [
  { id: 'para-0012', section: '说明书 [0012]', text: '柜体1形成用于陈列文物的封闭空间。环境传感模块2安装于柜体内部，可采集温度、相对湿度等环境数据，并将数据发送至控制模块3。' },
  { id: 'para-0018', section: '说明书 [0018]', text: '在一种实施方式中，多个温湿度传感器沿柜体对角线布置，由此可降低局部气流造成的测量偏差。传感器数量可根据柜体容积设定。' },
  { id: 'para-0024', section: '说明书 [0024]', text: '控制模块可比较当前湿度与预设区间，并结合历史变化趋势生成调节等级。当偏差持续超过阈值时，控制模块启动除湿单元并提高调节频率。' },
  { id: 'para-0031', section: '说明书 [0031]', text: '控制模块与传感模块之间可以采用有线或无线通信。通信链路可周期传输数据，传输周期例如为十秒至五分钟。' },
  { id: 'para-0040', section: '说明书 [0040]', text: '微环境调节包括湿度调节、温度调节及气体交换。控制策略可记录执行结果，用于后续趋势判断。' }
]
const initialFeatures: Feature[] = [
  { id: 'feature-a', claimId: 'claim-1', label: 'A · 柜体', text: '柜体', parentId: null, referenceIds: [], supportIds: ['para-0012'], ownerRole: 'author' },
  { id: 'feature-b', claimId: 'claim-1', label: 'B · 环境传感模块', text: '设置于柜体内，用于采集温湿度数据', parentId: 'feature-a', referenceIds: [], supportIds: ['para-0012', 'para-0018'], ownerRole: 'author' },
  { id: 'feature-c', claimId: 'claim-1', label: 'C · 控制模块通信', text: '与环境传感模块通信', parentId: 'feature-a', referenceIds: ['feature-b'], supportIds: ['para-0012', 'para-0031'], ownerRole: 'author' },
  { id: 'feature-d', claimId: 'claim-1', label: 'D · 调节微环境', text: '根据温湿度数据调节柜体微环境', parentId: null, referenceIds: ['feature-b', 'feature-c'], supportIds: ['para-0024', 'para-0040'], ownerRole: 'author' },
  { id: 'feature-e', claimId: 'claim-2', label: 'E · 对角线布置', text: '多个温湿度传感器沿柜体对角线布置', parentId: null, referenceIds: [], supportIds: ['para-0018'], ownerRole: 'author' },
  { id: 'feature-f', claimId: 'claim-3', label: 'F · 分级调节', text: '基于历史数据与当前数据的偏差分级调节除湿单元', parentId: null, referenceIds: [], supportIds: ['para-0024'], ownerRole: 'author' }
]
const initialAnnotations: Annotation[] = [
  { id: 'annotation-1', featureId: 'feature-b', authorRole: 'examiner', authorName: '审查员 · 李岚', text: '“温湿度数据”是否包括露点等派生数据？建议在从属权利要求中限定。', updatedAt: '2026-09-24T03:10:00.000Z' },
  { id: 'annotation-2', featureId: 'feature-d', authorRole: 'author', authorName: '代理人 · 陈昊', text: '[0024] 已支持分级调节，发布前补充除湿单元与通信模块的连接关系。', updatedAt: '2026-09-24T04:05:00.000Z' }
]
function demoState(): WorkbenchState {
  return {
    claims: initialClaims, paragraphs: initialParagraphs, features: initialFeatures,
    annotations: initialAnnotations, reviewLines: [], orphanMappings: [], versions: [],
    role: 'author', currentUserRole: 'author', selectedClaimId: 'claim-1', selectedFeatureId: 'feature-b', activeTab: 'mapping'
  }
}
function clone<T>(value: T): T { return structuredClone(value) }

/** 去掉空白与全角差异并转小写，用于编号比对与批注去重。 */
function normalizeToken(value: string): string {
  return value.replace(/[Ａ-Ｚａ-ｚ０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]+/g, '')
    .toLowerCase()
}
/** 特征标签的编号部分，如 “A · 柜体” → “a”；“2.3 · …” → “2.3”。 */
function labelCode(label: string): string {
  return normalizeToken(label.split('·')[0].trim())
}
function normalizeComment(text: string): string {
  return normalizeToken(text.replace(/[“”"']/g, ''))
}

@Injectable({ providedIn: 'root' })
export class WorkbenchService implements OnDestroy {
  private readonly initialState = this.loadState()
  private readonly stateSubject = new BehaviorSubject<WorkbenchState>(this.initialState)
  private readonly historySubject = new BehaviorSubject<{ past: number; future: number }>({ past: 0, future: 0 })
  private past: HistoryEntry[] = []
  private future: HistoryEntry[] = []
  private reviewSeq = 0

  readonly state$ = this.stateSubject.asObservable()
  readonly history$ = this.historySubject.asObservable()
  readonly claims$ = this.state$.pipe(map(state => state.claims))
  readonly paragraphs$ = this.state$.pipe(map(state => state.paragraphs))
  readonly features$ = this.state$.pipe(map(state => state.features))
  readonly annotations$ = this.state$.pipe(map(state => state.annotations))
  readonly reviewLines$ = this.state$.pipe(map(state => state.reviewLines))
  readonly role$ = this.state$.pipe(map(state => state.role))
  readonly selectedClaim$ = this.state$.pipe(map(state => state.claims.find(claim => claim.id === state.selectedClaimId) || state.claims[0]))
  readonly selectedFeature$ = this.state$.pipe(map(state => state.features.find(feature => feature.id === state.selectedFeatureId) || null))
  readonly issues$ = this.state$.pipe(map(state => this.validate(state)))

  constructor() {
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => this.savePosition())
  }

  ngOnDestroy(): void {
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', () => this.savePosition())
  }

  get snapshot(): WorkbenchState { return clone(this.stateSubject.value) }
  get canUndo(): boolean { return this.past.length > 0 && this.entryReachable(this.past[this.past.length - 1]) }
  get canRedo(): boolean { return this.future.length > 0 && this.entryReachable(this.future[this.future.length - 1]) }
  get undoBlockedByRole(): boolean { return this.past.length > 0 && !this.entryReachable(this.past[this.past.length - 1]) }
  get redoBlockedByRole(): boolean { return this.future.length > 0 && !this.entryReachable(this.future[this.future.length - 1]) }

  authorName(role: Role): string {
    return ({ author: '代理人 · 陈昊', examiner: '审查员 · 李岚', viewer: '观察者' })[role]
  }

  selectClaim(id: string): void {
    this.patchState(state => { state.selectedClaimId = id; state.selectedFeatureId = state.features.find(feature => feature.claimId === id)?.id || null })
    this.savePosition()
  }

  selectFeature(id: string | null): void {
    this.patchState(state => { state.selectedFeatureId = id })
    this.savePosition()
  }

  setRole(role: Role): void {
    this.patchState(state => { state.role = role; state.currentUserRole = role })
    this.updateHistory()
  }

  setTab(tab: string): void {
    this.patchState(state => { state.activeTab = tab })
    this.savePosition()
  }

  updateClaim(patch: Partial<Claim>): void {
    this.commit(state => {
      const claim = state.claims.find(item => item.id === state.selectedClaimId)
      if (claim) Object.assign(claim, patch)
    })
  }

  addClaim(): void {
    this.commit(state => {
      const number = Math.max(0, ...state.claims.map(claim => claim.number)) + 1
      const claim: Claim = { id: `claim-${Date.now()}`, number, title: `权利要求 ${number}`, independent: false, text: '请录入权利要求正文。' }
      state.claims.push(claim)
      state.selectedClaimId = claim.id
      state.selectedFeatureId = null
    })
  }

  addParagraph(): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const next = state.paragraphs.length + 1
      state.paragraphs.push({ id: `para-${Date.now()}`, section: `说明书 [${String(next * 5).padStart(4, '0')}]`, text: '' })
    })
  }

  updateParagraph(id: string, patch: Partial<Paragraph>): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const paragraph = state.paragraphs.find(item => item.id === id)
      if (paragraph) Object.assign(paragraph, patch)
    })
  }

  deleteParagraph(id: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      state.paragraphs = state.paragraphs.filter(item => item.id !== id)
      state.features.forEach(feature => { feature.supportIds = feature.supportIds.filter(paragraphId => paragraphId !== id) })
      state.orphanMappings = state.orphanMappings.filter(item => item.paragraphId !== id)
    })
  }

  addFeature(): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const feature: Feature = {
        id: `feature-${Date.now()}`, claimId: state.selectedClaimId,
        label: `新特征 ${state.features.filter(item => item.claimId === state.selectedClaimId).length + 1}`,
        text: '', parentId: null, referenceIds: [], supportIds: [], ownerRole: state.role
      }
      state.features.push(feature)
      state.selectedFeatureId = feature.id
    })
  }

  updateFeature(id: string, patch: Partial<Feature>): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const feature = state.features.find(item => item.id === id)
      if (feature) Object.assign(feature, patch)
    })
  }

  deleteFeature(id: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const feature = state.features.find(item => item.id === id)
      if (!feature) return
      feature.supportIds.forEach(paragraphId => state.orphanMappings.push({
        id: `orphan-${Date.now()}-${paragraphId}`, featureLabel: feature.label, paragraphId,
        reason: `技术特征“${feature.label}”已删除，但支持段落映射仍被保留。`
      }))
      state.features = state.features.filter(item => item.id !== id)
      state.features.forEach(item => {
        item.referenceIds = item.referenceIds.filter(refId => refId !== id)
        if (item.parentId === id) item.parentId = null
      })
      state.annotations = state.annotations.filter(item => item.featureId !== id)
      // 特征删除后，引用该特征的意见行回到待认领区；歧义候选中移除该特征。
      state.reviewLines.forEach(line => {
        if (line.featureId === id) this.resetReviewLine(line)
        line.candidateIds = line.candidateIds.filter(candidateId => candidateId !== id)
      })
      state.selectedFeatureId = state.features.find(item => item.claimId === state.selectedClaimId)?.id || null
    })
  }

  toggleParagraphMapping(featureId: string, paragraphId: string): void {
    if (this.stateSubject.value.role === 'viewer') return
    this.commit(state => {
      const feature = state.features.find(item => item.id === featureId)
      if (!feature) return
      const index = feature.supportIds.indexOf(paragraphId)
      if (index >= 0) feature.supportIds.splice(index, 1)
      else feature.supportIds.push(paragraphId)
      state.orphanMappings = state.orphanMappings.filter(item => item.paragraphId !== paragraphId)
    })
  }

  clearOrphan(id: string): void {
    this.commit(state => { state.orphanMappings = state.orphanMappings.filter(item => item.id !== id) })
  }

  addAnnotation(featureId: string, text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    const role = this.stateSubject.value.role
    if (role === 'viewer') return
    this.commit(state => state.annotations.push({
      id: `annotation-${Date.now()}`, featureId, authorRole: role, authorName: this.authorName(role), text: trimmed, updatedAt: new Date().toISOString()
    }), role)
  }

  updateAnnotation(id: string, text: string): void {
    this.commit(state => {
      const annotation = state.annotations.find(item => item.id === id)
      if (annotation && annotation.authorRole === state.role) annotation.text = text
    }, this.stateSubject.value.role)
  }

  deleteAnnotation(id: string): void {
    const role = this.stateSubject.value.role
    this.commit(state => {
      const annotation = state.annotations.find(item => item.id === id)
      if (!annotation || annotation.authorRole !== role) return
      state.annotations = state.annotations.filter(item => item.id !== id)
      // 批注被本人删除后，由该批注产生的意见行回到共享待认领区，可重新处理。
      state.reviewLines.forEach(line => {
        if (line.annotationId === id) this.resetReviewLine(line)
      })
    }, role)
  }

  // ===== 批量核对 =====

  /** 解析“特征编号|意见”并与当前特征做唯一匹配（不修改状态）。 */
  previewReviewImport(raw: string, currentClaimOnly: boolean): ReviewPreviewRow[] {
    const state = this.stateSubject.value
    const scopeIds = currentClaimOnly ? new Set(state.features.filter(feature => feature.claimId === state.selectedClaimId).map(feature => feature.id)) : null
    return raw.split(/\r?\n/).map((text, index) => {
      const line = index + 1
      const separator = text.indexOf('|')
      const empty: ReviewPreviewRow = { line, ref: '', comment: '', matchKind: 'not-found', featureId: null, candidateIds: [], duplicateAnnotationId: null, invalid: true }
      if (separator < 0) return { ...empty, ref: text.trim(), comment: '' }
      const ref = text.slice(0, separator).trim()
      const comment = text.slice(separator + 1).trim()
      if (!ref || !comment) return { ...empty, ref, comment }
      // 显式写了权利要求号（如 2-E）时不受“仅当前权利要求”范围限制。
      const explicitClaim = this.parseRef(ref).claimNumber !== null
      const match = this.matchFeature(ref, state, explicitClaim ? null : scopeIds)
      const duplicateAnnotationId = match.featureId
        ? state.annotations.find(annotation => annotation.featureId === match.featureId && annotation.authorRole === state.role && normalizeComment(annotation.text) === normalizeComment(comment))?.id || null
        : null
      return { line, ref, comment, matchKind: match.kind, featureId: match.featureId, candidateIds: match.candidateIds, duplicateAnnotationId, invalid: false }
    }).filter(row => row.ref || row.comment)
  }

  /**
   * 批量导入：唯一匹配且不重复的行直接生成本人批注；重复内容不重复生成；
   * 对不上或有歧义的行进入待认领区。整批操作可一次撤销/重做。
   */
  importReview(raw: string, currentClaimOnly: boolean): ImportReviewResult {
    const role = this.stateSubject.value.role
    if (role === 'viewer' || !raw.trim()) return { imported: 0, annotated: 0, duplicate: 0, pending: 0 }
    const rows = this.previewReviewImport(raw, currentClaimOnly).filter(row => !row.invalid)
    if (!rows.length) return { imported: 0, annotated: 0, duplicate: 0, pending: 0 }
    const result: ImportReviewResult = { imported: 0, annotated: 0, duplicate: 0, pending: 0 }
    this.commit(state => {
      const batchSeen = new Set<string>()
      const now = new Date().toISOString()
      for (const row of rows) {
        const key = `${row.featureId || ''}|${normalizeComment(row.comment)}`
        const alreadyInBatch = row.featureId && batchSeen.has(key)
        if (row.featureId) batchSeen.add(key)
        const duplicateId = alreadyInBatch
          ? state.annotations.find(annotation => annotation.featureId === row.featureId && annotation.authorRole === role && normalizeComment(annotation.text) === normalizeComment(row.comment))?.id || null
          : row.duplicateAnnotationId
        const isDuplicate = !!duplicateId || !!alreadyInBatch
        if (row.matchKind === 'auto' && row.featureId && !isDuplicate) {
          const annotationId = `annotation-review-${Date.now()}-${this.reviewSeq++}`
          state.annotations.push({ id: annotationId, featureId: row.featureId, authorRole: role, authorName: this.authorName(role), text: row.comment, updatedAt: now })
          state.reviewLines.push(this.buildReviewLine(state, row, 'annotated', row.featureId, annotationId, role, null, now))
          result.annotated++
        } else if (isDuplicate) {
          state.reviewLines.push(this.buildReviewLine(state, row, 'duplicate', row.featureId, duplicateId, role, null, now))
          result.duplicate++
        } else {
          state.reviewLines.push(this.buildReviewLine(state, row, 'pending', null, null, role, null, now))
          result.pending++
        }
        result.imported++
      }
    }, role)
    return result
  }

  /** 认领待认领项：选择目标特征后生成本人批注；仅本人可撤销自己的认领。 */
  claimReviewLine(lineId: string, featureId: string): void {
    const role = this.stateSubject.value.role
    if (role === 'viewer') return
    const target = this.stateSubject.value.features.find(feature => feature.id === featureId)
    if (!target) return
    this.commit(state => {
      const line = state.reviewLines.find(item => item.id === lineId)
      if (!line || line.status !== 'pending' || line.claimedByRole) return
      const existing = state.annotations.find(annotation => annotation.featureId === featureId && annotation.authorRole === role && normalizeComment(annotation.text) === normalizeComment(line.comment))
      const now = new Date().toISOString()
      if (existing) {
        line.status = 'duplicate'
        line.featureId = featureId
        line.annotationId = existing.id
        line.matchKind = 'auto'
        line.candidateIds = []
        line.claimedByRole = role
        line.updatedAt = now
        return
      }
      const annotationId = `annotation-review-${Date.now()}-${this.reviewSeq++}`
      state.annotations.push({ id: annotationId, featureId, authorRole: role, authorName: this.authorName(role), text: line.comment, updatedAt: now })
      line.status = 'annotated'
      line.featureId = featureId
      line.annotationId = annotationId
      line.matchKind = 'auto'
      line.candidateIds = []
      line.claimedByRole = role
      line.updatedAt = now
    }, role)
  }

  /** 撤回已处理的意见行：导入者或认领者可撤回，生成的批注一并删除，行回到待认领区。 */
  releaseReviewLine(lineId: string): void {
    const role = this.stateSubject.value.role
    if (role === 'viewer') return
    this.commit(state => {
      const line = state.reviewLines.find(item => item.id === lineId)
      if (!line || line.status === 'pending') return
      if (line.importedByRole !== role && line.claimedByRole !== role) return
      // 仅删除批量处理生成的批注；重复行指向的历史批注保留。
      if (line.annotationId?.startsWith('annotation-review-')) state.annotations = state.annotations.filter(annotation => annotation.id !== line.annotationId)
      this.resetReviewLine(line)
    }, role)
  }

  /** 丢弃未被认领的待处理行：仅导入者本人可丢弃，他人的待认领项不可动。 */
  dismissReviewLine(lineId: string): void {
    const role = this.stateSubject.value.role
    if (role === 'viewer') return
    this.commit(state => {
      const line = state.reviewLines.find(item => item.id === lineId)
      if (line && line.status === 'pending' && !line.claimedByRole && line.importedByRole === role) {
        state.reviewLines = state.reviewLines.filter(item => item.id !== lineId)
      }
    }, role)
  }

  createVersion(name?: string): void {
    this.commit(state => {
      state.versions.unshift({
        id: `version-${Date.now()}`, name: name?.trim() || `快照 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        createdAt: new Date().toISOString(), claims: clone(state.claims), features: clone(state.features)
      })
    })
  }

  restoreVersion(id: string): void {
    this.commit(state => {
      const version = state.versions.find(item => item.id === id)
      if (!version) return
      state.claims = clone(version.claims)
      state.features = clone(version.features)
      if (!state.claims.some(claim => claim.id === state.selectedClaimId)) state.selectedClaimId = state.claims[0]?.id || ''
      state.selectedFeatureId = state.features.find(feature => feature.claimId === state.selectedClaimId)?.id || null
      this.reconcileReviewLines(state)
    })
  }

  undo(): void {
    const entry = this.past[this.past.length - 1]
    if (!entry || !this.entryReachable(entry)) return
    this.past.pop()
    this.future.push({ state: clone(this.stateSubject.value), scope: entry.scope })
    this.stateSubject.next(entry.state)
    this.updateHistory()
    this.saveState()
  }

  redo(): void {
    const entry = this.future[this.future.length - 1]
    if (!entry || !this.entryReachable(entry)) return
    this.future.pop()
    this.past.push({ state: clone(this.stateSubject.value), scope: entry.scope })
    this.stateSubject.next(entry.state)
    this.updateHistory()
    this.saveState()
  }

  savePosition(): void {
    if (typeof localStorage === 'undefined') return
    const state = this.stateSubject.value
    const position: Position = { tab: state.activeTab, claimId: state.selectedClaimId, featureId: state.selectedFeatureId, scrollY: window.scrollY }
    localStorage.setItem(POSITION_KEY, JSON.stringify(position))
    this.saveState()
  }

  readPosition(): Position {
    if (typeof localStorage === 'undefined') return { tab: this.initialState.activeTab, claimId: this.initialState.selectedClaimId, featureId: this.initialState.selectedFeatureId, scrollY: 0 }
    try { return { ...JSON.parse(localStorage.getItem(POSITION_KEY) || '{}'), ...this.stateSubject.value } } catch { return { tab: 'mapping', claimId: this.initialState.selectedClaimId, featureId: this.initialState.selectedFeatureId, scrollY: 0 } }
  }

  exportJson(): string { return JSON.stringify({ ...this.snapshot, validationIssues: this.validate(this.stateSubject.value) }, null, 2) }

  exportCsv(): string {
    const state = this.stateSubject.value
    const rows = state.features.map(feature => [
      state.claims.find(claim => claim.id === feature.claimId)?.number || '', feature.label, feature.text,
      state.features.find(item => item.id === feature.parentId)?.label || '',
      feature.referenceIds.map(id => state.features.find(item => item.id === id)?.label || id).join('；'),
      feature.supportIds.map(id => state.paragraphs.find(item => item.id === id)?.section || id).join('；')
    ])
    const csv = [['权利要求', '技术特征', '特征内容', '父级特征', '引用特征', '支持段落'], ...rows]
      .map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n')
    return `﻿${csv}`
  }

  validate(state = this.stateSubject.value): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    for (const feature of state.features) {
      if (!feature.text.trim()) issues.push({ id: `empty-${feature.id}`, severity: 'warning', type: 'empty-feature', featureId: feature.id, title: `${feature.label} 内容为空`, detail: '请补全技术特征文字，避免映射对象不明确。' })
      if (!feature.supportIds.length) issues.push({ id: `support-${feature.id}`, severity: 'error', type: 'missing-support', featureId: feature.id, title: `${feature.label} 缺少说明书依据`, detail: '至少为一个说明书段落建立支持映射。' })
      if (this.hasReferenceCycle(feature, state.features)) issues.push({ id: `cycle-${feature.id}`, severity: 'error', type: 'cycle', featureId: feature.id, title: `${feature.label} 存在循环引用`, detail: '特征层级或引用关系形成闭环，请移除其中一条关系。' })
    }
    state.orphanMappings.forEach(item => issues.push({ id: item.id, severity: 'warning', type: 'orphan-mapping', title: '存在待清理映射', detail: item.reason }))
    return issues
  }

  private hasReferenceCycle(start: Feature, features: Feature[]): boolean {
    const visited = new Set<string>()
    const visit = (id: string): boolean => {
      if (id === start.id && visited.size > 0) return true
      if (visited.has(id)) return false
      visited.add(id)
      const feature = features.find(item => item.id === id)
      if (!feature) return false
      if (feature.parentId && visit(feature.parentId)) return true
      return feature.referenceIds.some(visit)
    }
    return visit(start.id)
  }

  private parseRef(rawRef: string): ParsedRef {
    // 支持“1-A”“权1-A”“权利要求1.A”“2-B”等带权利要求限定的编号。
    const match = rawRef.match(/^(?:权[利要求]*\s*)?(\d+)\s*[\-—.．、]?\s*(.+)$/)
    if (match && /[A-Za-zＡ-Ｚａ-ｚ]/.test(match[2])) {
      return { claimNumber: Number(match[1]), code: normalizeToken(match[2]) }
    }
    return { claimNumber: null, code: normalizeToken(rawRef) }
  }

  private matchFeature(rawRef: string, state: WorkbenchState, scopeIds: Set<string> | null): { kind: ReviewMatchKind; featureId: string | null; candidateIds: string[] } {
    const parsed = this.parseRef(rawRef)
    const inScope = (feature: Feature): boolean => !scopeIds || scopeIds.has(feature.id)
    let pool = state.features.filter(inScope)
    if (parsed.claimNumber !== null) {
      const claim = state.claims.find(item => item.number === parsed.claimNumber)
      // 限定了权利要求时只在该项内匹配，匹配不到即为“对不上”，不去别项猜。
      pool = claim ? pool.filter(feature => feature.claimId === claim.id) : []
    }
    const matches = pool.filter(feature =>
      labelCode(feature.label) === parsed.code ||
      normalizeToken(feature.label) === parsed.code ||
      normalizeToken(feature.id) === parsed.code)
    if (matches.length === 1) return { kind: 'auto', featureId: matches[0].id, candidateIds: [] }
    if (matches.length > 1) {
      return { kind: 'ambiguous', featureId: null, candidateIds: this.sortFeatureIds(matches.map(feature => feature.id), state) }
    }
    // 歧义时给出同编号候选，供认领时直接选择；“对不上”无候选。
    const candidates = pool.filter(feature => labelCode(feature.label) === parsed.code)
    return { kind: 'not-found', featureId: null, candidateIds: this.sortFeatureIds(candidates.map(feature => feature.id), state) }
  }

  private sortFeatureIds(ids: string[], state: WorkbenchState): string[] {
    return [...ids].sort((a, b) => {
      const fa = state.features.find(feature => feature.id === a)
      const fb = state.features.find(feature => feature.id === b)
      if (!fa || !fb) return 0
      const ca = state.claims.find(claim => claim.id === fa.claimId)?.number ?? 0
      const cb = state.claims.find(claim => claim.id === fb.claimId)?.number ?? 0
      if (ca !== cb) return ca - cb
      return state.features.indexOf(fa) - state.features.indexOf(fb)
    })
  }

  private buildReviewLine(state: WorkbenchState, row: ReviewPreviewRow, status: ReviewLine['status'], featureId: string | null, annotationId: string | null, importedByRole: Role, claimedByRole: Role | null, now: string): ReviewLine {
    return {
      id: `review-${Date.now()}-${this.reviewSeq++}`,
      ref: row.ref,
      comment: row.comment,
      matchKind: row.matchKind,
      status,
      featureId,
      candidateIds: row.candidateIds.filter(id => state.features.some(feature => feature.id === id)),
      annotationId,
      importedByRole,
      claimedByRole,
      createdAt: now,
      updatedAt: now
    }
  }

  private resetReviewLine(line: ReviewLine): void {
    line.status = 'pending'
    line.featureId = null
    line.annotationId = null
    line.claimedByRole = null
    line.matchKind = line.matchKind === 'auto' ? 'not-found' : line.matchKind
    line.updatedAt = new Date().toISOString()
  }

  /** 版本恢复等批量变更后，失效的特征引用回退为待认领。 */
  private reconcileReviewLines(state: WorkbenchState): void {
    state.reviewLines.forEach(line => {
      if (line.featureId && !state.features.some(feature => feature.id === line.featureId)) this.resetReviewLine(line)
      if (line.annotationId && !state.annotations.some(annotation => annotation.id === line.annotationId)) line.annotationId = null
      line.candidateIds = line.candidateIds.filter(id => state.features.some(feature => feature.id === id))
    })
  }

  private entryReachable(entry: HistoryEntry): boolean {
    return entry.scope === 'shared' || entry.scope === this.stateSubject.value.role
  }

  private commit(recipe: (state: WorkbenchState) => void, scope: CommitScope = 'shared'): void {
    const current = clone(this.stateSubject.value)
    const next = clone(current)
    recipe(next)
    // 被权限拦截等未产生实际变更的操作不进入撤销栈。
    if (JSON.stringify(current) === JSON.stringify(next)) return
    this.past.push({ state: current, scope })
    if (this.past.length > 60) this.past.shift()
    this.future = []
    this.stateSubject.next(next)
    this.updateHistory()
    this.saveState()
  }

  private patchState(recipe: (state: WorkbenchState) => void): void {
    const next = clone(this.stateSubject.value)
    recipe(next)
    this.stateSubject.next(next)
    this.saveState()
  }

  private updateHistory(): void { this.historySubject.next({ past: this.past.length, future: this.future.length }) }
  private saveState(): void { if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(this.stateSubject.value)) }
  private loadState(): WorkbenchState {
    if (typeof localStorage === 'undefined') return demoState()
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      return stored ? { ...demoState(), ...JSON.parse(stored) } : demoState()
    } catch { return demoState() }
  }
}

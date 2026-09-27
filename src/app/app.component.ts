import { AfterViewInit, Component, OnDestroy, OnInit } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { ButtonModule } from 'primeng/button'
import { InputTextModule } from 'primeng/inputtext'
import { TextareaModule } from 'primeng/textarea'
import { SelectModule } from 'primeng/select'
import { CardModule } from 'primeng/card'
import { BadgeModule } from 'primeng/badge'
import { DialogModule } from 'primeng/dialog'
import { TooltipModule } from 'primeng/tooltip'
import { Subscription } from 'rxjs'
import type { Annotation, Claim, Feature, ReviewLine, Role, ValidationIssue, WorkbenchState } from './models'
import { WorkbenchService, type ImportReviewResult, type ReviewPreviewRow } from './workbench.service'

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ButtonModule, InputTextModule, TextareaModule, SelectModule, CardModule, BadgeModule, DialogModule, TooltipModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit, AfterViewInit, OnDestroy {
  state: WorkbenchState
  issues: ValidationIssue[] = []
  history = { past: 0, future: 0 }
  compareA = ''
  compareB = ''
  annotationDraft = ''
  versionDialog = false
  versionName = ''
  activeIssue: ValidationIssue | null = null
  reviewDraft = 'A|“温湿度数据”是否包括露点等派生数据？建议在从属权利要求中限定。\n2-E|传感器沿对角线布置的数量依据不充分，请补充实施例。\n1-Z|“预测维护”特征在权利要求中缺少上位概括。\nC|请说明通信周期与调节频率之间的配合关系。\nE|多个传感器的校准方式未在权利要求中限定。'
  reviewScopeCurrent = false
  reviewImportResult: ImportReviewResult | null = null
  reviewClaimSelections: Record<string, string> = {}
  roleOptions: Array<{ label: string; value: Role }> = [
    { label: '代理人（可编辑主数据与本人批注）', value: 'author' },
    { label: '审查员（可编辑本人批注）', value: 'examiner' },
    { label: '观察者（只读）', value: 'viewer' }
  ]
  private subscriptions = new Subscription()

  constructor(readonly service: WorkbenchService) {
    this.state = service.snapshot
  }

  ngOnInit(): void {
    this.subscriptions.add(this.service.state$.subscribe(state => {
      this.state = structuredClone(state)
      this.syncVersions()
    }))
    this.subscriptions.add(this.service.issues$.subscribe(issues => this.issues = issues))
    this.subscriptions.add(this.service.history$.subscribe(history => this.history = history))
    window.addEventListener('keydown', this.handleKeyboard)
  }

  ngAfterViewInit(): void {
    const position = this.service.readPosition()
    setTimeout(() => window.scrollTo({ top: position.scrollY || 0, behavior: 'instant' as ScrollBehavior }), 0)
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe()
    window.removeEventListener('keydown', this.handleKeyboard)
  }

  get selectedClaim(): Claim | undefined { return this.state.claims.find(item => item.id === this.state.selectedClaimId) }
  get selectedFeature(): Feature | undefined { return this.state.features.find(item => item.id === this.state.selectedFeatureId) }
  get claimFeatures(): Feature[] { return this.state.features.filter(item => item.claimId === this.state.selectedClaimId) }
  get featureAnnotations(): Annotation[] { return this.selectedFeature ? this.state.annotations.filter(item => item.featureId === this.selectedFeature?.id) : [] }
  get currentRoleLabel(): string { return this.roleOptions.find(item => item.value === this.state.role)?.label || '' }
  get errorCount(): number { return this.issues.filter(item => item.severity === 'error').length }
  get warningCount(): number { return this.issues.filter(item => item.severity === 'warning').length }
  get canEditMainData(): boolean { return this.state.role !== 'viewer' }
  get mappedFeatureCount(): number { return this.claimFeatures.filter(feature => feature.supportIds.length > 0).length }

  // 批量核对
  get reviewLines(): ReviewLine[] { return this.state.reviewLines }
  get pendingReviewLines(): ReviewLine[] { return this.state.reviewLines.filter(line => line.status === 'pending' && !line.claimedByRole) }
  get handledReviewLines(): ReviewLine[] { return this.state.reviewLines.filter(line => line.status !== 'pending' || !!line.claimedByRole) }
  get pendingCount(): number { return this.pendingReviewLines.length }
  get canImportReview(): boolean { return this.state.role !== 'viewer' && !!this.reviewDraft.trim() }
  get canUndoReview(): boolean { return this.service.canUndo }
  get canRedoReview(): boolean { return this.service.canRedo }
  get undoBlocked(): boolean { return this.service.undoBlockedByRole }
  get redoBlocked(): boolean { return this.service.redoBlockedByRole }
  get reviewPreviewRows(): ReviewPreviewRow[] { return this.reviewDraft.trim() ? this.service.previewReviewImport(this.reviewDraft, this.reviewScopeCurrent) : [] }

  claimLabel(id: string): string { return this.state.claims.find(item => item.id === id)?.title || '未命名权利要求' }
  featureLabel(id: string): string { return this.state.features.find(item => item.id === id)?.label || id }
  paragraphLabel(id: string): string { return this.state.paragraphs.find(item => item.id === id)?.section || id }
  isMapped(feature: Feature, paragraphId: string): boolean { return feature.supportIds.includes(paragraphId) }
  isOwnAnnotation(annotation: Annotation): boolean { return annotation.authorRole === this.state.role }
  ownerLabel(role: Role): string { return ({ author: '代理人', examiner: '审查员', viewer: '观察者' })[role] }

  reviewFeatureLabel(id: string | null): string { return id ? this.featureLabel(id) : '未匹配特征' }
  reviewKindLabel(line: ReviewLine): string {
    if (line.status === 'annotated') return '已生成批注'
    if (line.status === 'duplicate') return '重复跳过'
    return line.matchKind === 'ambiguous' ? '歧义待认领' : '未匹配待认领'
  }
  reviewCandidates(line: ReviewLine): Feature[] {
    const byId = (id: string): Feature | undefined => this.state.features.find(feature => feature.id === id)
    const fromIds = (ids: string[]): Feature[] => ids.map(byId).filter((feature): feature is Feature => !!feature)
    const matched = fromIds(line.candidateIds)
    if (matched.length) return matched
    // 候选已被删除或“对不上”时，列出当前权利要求的全部特征供认领。
    return this.state.features.filter(feature => feature.claimId === this.state.selectedClaimId)
  }
  reviewClaimSelection(line: ReviewLine): string {
    if (!this.reviewClaimSelections[line.id]) {
      const preferred = line.candidateIds[0] || this.state.features.find(feature => feature.claimId === this.state.selectedClaimId)?.id || this.state.features[0]?.id || ''
      this.reviewClaimSelections[line.id] = preferred
    }
    return this.reviewClaimSelections[line.id]
  }
  setReviewClaimSelection(line: ReviewLine, value: string): void { this.reviewClaimSelections[line.id] = value }
  canClaim(line: ReviewLine): boolean { return line.status === 'pending' && !line.claimedByRole && this.state.role !== 'viewer' && !!this.reviewClaimSelection(line) }
  canRelease(line: ReviewLine): boolean {
    if (this.state.role === 'viewer' || line.status === 'pending') return false
    return line.importedByRole === this.state.role || line.claimedByRole === this.state.role
  }
  canDismiss(line: ReviewLine): boolean {
    return this.state.role !== 'viewer' && line.status === 'pending' && !line.claimedByRole && line.importedByRole === this.state.role
  }
  importReview(): void {
    this.reviewImportResult = this.service.importReview(this.reviewDraft, this.reviewScopeCurrent)
    if ((this.reviewImportResult?.imported || 0) > 0) this.reviewDraft = ''
  }
  claimLine(line: ReviewLine): void {
    const featureId = this.reviewClaimSelection(line)
    if (!featureId) return
    this.service.claimReviewLine(line.id, featureId)
    delete this.reviewClaimSelections[line.id]
  }
  releaseLine(line: ReviewLine): void { this.service.releaseReviewLine(line.id) }
  dismissLine(line: ReviewLine): void { this.service.dismissReviewLine(line.id) }
  jumpToFeature(featureId: string | null): void {
    if (!featureId) return
    const feature = this.state.features.find(item => item.id === featureId)
    if (feature) {
      this.service.selectClaim(feature.claimId)
      this.service.selectFeature(featureId)
      this.service.setTab('mapping')
    }
  }

  updateClaimField(field: 'title' | 'text' | 'number' | 'independent', event: Event): void {
    const element = event.target as HTMLInputElement
    const value = field === 'number' ? Number(element.value) : field === 'independent' ? element.checked : element.value
    this.service.updateClaim({ [field]: value })
  }

  updateFeatureField(field: 'label' | 'text', event: Event): void {
    if (!this.selectedFeature) return
    this.service.updateFeature(this.selectedFeature.id, { [field]: (event.target as HTMLInputElement | HTMLTextAreaElement).value })
  }

  updateFeatureParent(event: Event): void {
    if (!this.selectedFeature) return
    this.service.updateFeature(this.selectedFeature.id, { parentId: (event.target as HTMLSelectElement).value || null })
  }

  toggleReference(featureId: string, checked: boolean): void {
    if (!this.selectedFeature) return
    const ids = checked
      ? Array.from(new Set([...this.selectedFeature.referenceIds, featureId]))
      : this.selectedFeature.referenceIds.filter(id => id !== featureId)
    this.service.updateFeature(this.selectedFeature.id, { referenceIds: ids })
  }

  addAnnotation(): void {
    if (!this.selectedFeature) return
    this.service.addAnnotation(this.selectedFeature.id, this.annotationDraft)
    this.annotationDraft = ''
  }

  updateAnnotation(annotation: Annotation, event: Event): void {
    this.service.updateAnnotation(annotation.id, (event.target as HTMLTextAreaElement).value)
  }

  createVersion(): void {
    this.service.createVersion(this.versionName)
    this.versionName = ''
    this.versionDialog = false
  }

  restoreVersion(id: string): void {
    this.service.restoreVersion(id)
  }

  getVersion(id: string) { return this.state.versions.find(item => item.id === id) }
  compareRows(): Array<{ label: string; before: string; after: string; changed: boolean }> {
    const a = this.getVersion(this.compareA)
    const b = this.getVersion(this.compareB)
    if (!a || !b) return []
    const ids = Array.from(new Set([...a.claims.map(item => item.id), ...b.claims.map(item => item.id)]))
    return ids.map(id => {
      const before = a.claims.find(item => item.id === id)?.text || ''
      const after = b.claims.find(item => item.id === id)?.text || ''
      return { label: `权利要求 ${a.claims.find(item => item.id === id)?.number || b.claims.find(item => item.id === id)?.number || '?'}`, before, after, changed: before !== after }
    })
  }

  exportFile(type: 'json' | 'csv'): void {
    const content = type === 'json' ? this.service.exportJson() : this.service.exportCsv()
    const mime = type === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8'
    const url = URL.createObjectURL(new Blob([content], { type: mime }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `patent-claim-check-${new Date().toISOString().slice(0, 10)}.${type}`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  locateIssue(issue: ValidationIssue): void {
    this.activeIssue = issue
    if (issue.featureId) this.service.selectFeature(issue.featureId)
    this.service.setTab('mapping')
  }

  closeIssue(): void { this.activeIssue = null }

  private syncVersions(): void {
    if (!this.state.versions.some(item => item.id === this.compareA)) this.compareA = this.state.versions[1]?.id || this.state.versions[0]?.id || ''
    if (!this.state.versions.some(item => item.id === this.compareB)) this.compareB = this.state.versions[0]?.id || ''
  }

  private handleKeyboard = (event: KeyboardEvent): void => {
    if (!(event.metaKey || event.ctrlKey)) return
    if (event.key.toLowerCase() === 'z') {
      event.preventDefault()
      event.shiftKey ? this.service.redo() : this.service.undo()
    } else if (event.key.toLowerCase() === 'y') {
      event.preventDefault()
      this.service.redo()
    } else if (event.key.toLowerCase() === 's') {
      event.preventDefault()
      this.versionDialog = true
    }
  }
}

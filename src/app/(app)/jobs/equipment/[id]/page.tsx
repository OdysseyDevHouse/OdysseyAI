import { notFound } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { getAsset, assetHistory } from '@/lib/site/jobAssets'
import { listActivity } from '@/lib/site/activityLog'
import {
  PageHeader,
  PageBody,
  Badge,
  Callout,
  Card,
  CardHeader,
  CardBody,
  ButtonLink,
  TextLink,
  EmptyState,
  Icons,
} from '@/components/ui'
import { TABLE, TABLE_HEAD_ROW, TABLE_TD, TABLE_TH } from '@/components/ui/styles'
import EquipmentActions from './EquipmentActions'
import CustomFieldsPanel from '@/components/CustomFieldsPanel'
import { valuesFor } from '@/lib/site/customFields'
import { setAssetCustomValuesAction } from '../../actions'

export const dynamic = 'force-dynamic'

/**
 * One piece of equipment, and everything that has been done to it.
 *
 * ── THE HISTORY IS A QUERY ─────────────────────────────────────────────────
 *
 * `assetHistory()` reads the job list directly. There is no history table,
 * because it would be a second copy of the job list and the two would drift the
 * first time a job was cancelled. The consequence worth naming: cancelled jobs
 * appear here, marked as such — a visit that was called off is part of the story
 * of a unit, and hiding it would make the record read as though nobody ever came
 * out.
 *
 * Since 161 it spans BOTH sources: jobs this unit was the subject of, and jobs
 * where it was one of several looked at. The second kind is badged, because the
 * difference matters to a warranty. A history that showed only the first would
 * tell a technician the unit had never been touched on any multi-unit visit.
 */
export default async function EquipmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { siteId, capabilities } = await requireModuleCapability('job_cards', 'jobs.view')
  const { id } = await params

  const assetId = Number(id)
  if (!Number.isFinite(assetId) || assetId <= 0) notFound()

  const asset = await getAsset(siteId, assetId)
  if (!asset) notFound()

  const [history, activity, customValues] = await Promise.all([
    assetHistory(siteId, assetId),
    listActivity(siteId, 'customer_asset', assetId, 40),
    // Custom fields (§24). Tolerant of a site without 127; the panel renders
    // nothing when no equipment fields are defined.
    valuesFor(siteId, 'equipment', assetId),
  ])

  const today = new Date().toISOString().slice(0, 10)
  const warrantyExpired = asset.warrantyUntil !== null && asset.warrantyUntil < today
  const serviceDue = asset.nextServiceOn !== null && asset.nextServiceOn <= today
  const canEdit = can(capabilities, 'jobs.edit')

  return (
    <>
      <PageHeader
        title={asset.description}
        subtitle={[asset.documentNumber, asset.make, asset.model].filter(Boolean).join(' · ')}
        action={
          canEdit ? (
            <div className="flex items-center gap-2">
              <ButtonLink href={`/jobs/equipment/${asset.id}/edit`} variant="secondary">
                <Icons.Pencil size={15} />
                Edit
              </ButtonLink>
              <EquipmentActions
                assetId={asset.id}
                isActive={asset.isActive}
                jobCount={asset.jobCount}
                description={asset.description}
              />
            </div>
          ) : undefined
        }
      />
      <PageBody>
        {/* Above everything: whether it is retired changes how to read the rest. */}
        {!asset.isActive && (
          <Callout tone="neutral" title="This equipment is retired">
            {asset.retiredReason ?? 'No reason was recorded.'}
            {asset.retiredOn ? ` (${asset.retiredOn})` : ''} Its history stays here.
          </Callout>
        )}

        {serviceDue && asset.isActive && (
          <Callout tone="warning" title="A service is due">
            Due {asset.nextServiceOn}. Raising a job against this unit and closing it is what moves
            the date forward.
          </Callout>
        )}

        <Card>
          <CardHeader
            title="What it is"
            description={asset.assetTypeName ?? 'No kind recorded'}
          />
          <CardBody>
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <dt className="text-muted">{asset.identifierLabel}</dt>
                <dd className="text-ink-2">
                  {asset.serialText ?? <span className="text-muted">none on the plate</span>}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Customer</dt>
                <dd className="text-ink-2">
                  {asset.customerId === null ? (
                    // Not a fault: a unit can be in the workshop before anybody
                    // claims it, which is exactly what nullable customer_id is for.
                    <span className="text-muted">not claimed yet</span>
                  ) : (
                    <TextLink href={`/customers/${asset.customerId}`}>{asset.customerName}</TextLink>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Where it is</dt>
                <dd className="text-ink-2">
                  {asset.serviceAddressName ?? <span className="text-muted">not specified</span>}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Warranty</dt>
                <dd>
                  {asset.warrantyUntil === null ? (
                    <span className="text-muted">not recorded</span>
                  ) : warrantyExpired ? (
                    // Expired decides who pays, so it is stated rather than badged
                    // green-then-grey: a technician glancing needs the word.
                    <span className="text-muted">expired {asset.warrantyUntil}</span>
                  ) : (
                    <Badge tone="success">until {asset.warrantyUntil}</Badge>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Installed</dt>
                <dd className="text-ink-2">
                  {asset.installedOn ?? <span className="text-muted">not recorded</span>}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Purchased</dt>
                <dd className="text-ink-2">
                  {asset.purchasedOn ?? <span className="text-muted">not recorded</span>}
                  {asset.purchaseReference ? ` · ${asset.purchaseReference}` : ''}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Last serviced</dt>
                <dd className="text-ink-2">
                  {asset.lastServiceOn ?? <span className="text-muted">never</span>}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Next service</dt>
                <dd className="text-ink-2">
                  {asset.nextServiceOn ?? <span className="text-muted">on demand</span>}
                </dd>
              </div>
              {asset.productCode && (
                <div>
                  <dt className="text-muted">We sold it</dt>
                  <dd className="text-ink-2">{asset.productCode}</dd>
                </div>
              )}
            </dl>

            {asset.conditionNote && (
              <p className="mt-4 text-sm text-ink-2">{asset.conditionNote}</p>
            )}
            {asset.note && (
              /* The most useful sentence on the screen to somebody standing in
                 front of the unit, so it is not buried. */
              <p className="mt-2 whitespace-pre-line text-sm text-warning-ink">{asset.note}</p>
            )}
          </CardBody>
        </Card>

        {/* What this business records about a unit that the app does not ask
            for. Between what it IS and what was DONE to it, because that is
            what it is: more of the first. */}
        <CustomFieldsPanel
          entity="equipment"
          entityId={asset.id}
          fields={customValues}
          canEdit={canEdit}
          onSave={setAssetCustomValuesAction}
        />

        <Card>
          <CardHeader
            title="What has been done to it"
            description="Every job that named this unit, newest first. Cancelled visits appear too — a call-off is part of the story."
          />
          {history.length === 0 ? (
            <EmptyState
              icon={<Icons.Wrench size={22} />}
              title="No work recorded yet"
              hint="Name this unit on a job and its history builds itself. Nothing has to be copied across."
            />
          ) : (
            <CardBody className="p-0">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Job</th>
                    <th className={TABLE_TH}>What</th>
                    <th className={TABLE_TH}>Stage</th>
                    <th className={TABLE_TH}>Logged</th>
                    <th className={TABLE_TH}>Closed</th>
                    <th className={TABLE_TH}>By</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.jobId}>
                      <td className={TABLE_TD}>
                        <TextLink href={`/jobs/${h.jobId}`}>
                          {h.documentNumber ?? `#${h.jobId}`}
                        </TextLink>
                      </td>
                      <td className={TABLE_TD}>
                        <span className="text-ink-2">{h.title}</span>
                        {/* A visit that covered several units, of which this was
                            one (161). Worth marking rather than hiding: "we came
                            out for this" and "we checked it while we were there"
                            are different facts about a warranty. */}
                        {!h.isPrimary && (
                          <Badge tone="neutral" className="ml-2">
                            Also on this visit
                          </Badge>
                        )}
                      </td>
                      <td className={TABLE_TD}>
                        {h.lifecycle === 'cancelled' ? (
                          <Badge tone="danger">Called off</Badge>
                        ) : (
                          <span className="text-ink-2">{h.statusName}</span>
                        )}
                      </td>
                      <td className={TABLE_TD}>
                        <span className="text-muted">{h.reportedAt ?? '—'}</span>
                      </td>
                      <td className={TABLE_TD}>
                        <span className="text-muted">{h.closedAt ?? '—'}</span>
                      </td>
                      <td className={TABLE_TD}>
                        <span className="text-muted">{h.ownerName || '—'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          )}
        </Card>

        {activity.length > 0 && (
          <Card>
            <CardHeader
              title="Changes to this record"
              description="Separate from the work: this is who edited the warranty date, moved it to another site, or retired it."
            />
            <CardBody className="p-0">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>What</th>
                    <th className={TABLE_TH}>Who</th>
                    <th className={TABLE_TH}>When</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.map((a) => (
                    <tr key={a.id}>
                      <td className={TABLE_TD}>
                        <span className="text-ink-2">{a.detail || a.action}</span>
                      </td>
                      <td className={TABLE_TD}>
                        <span className="text-muted">{a.userName}</span>
                      </td>
                      <td className={TABLE_TD}>
                        {/*
                          `createdAt` is a raw driver Date, and String() on one is a
                          LOCALE string — slicing it produced "hu Aug 13 2026".
                          toLocaleString is what the job history already uses.
                        */}
                        <span className="text-muted">
                          {new Date(a.createdAt).toLocaleString('en-ZA', {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>
        )}
      </PageBody>
    </>
  )
}

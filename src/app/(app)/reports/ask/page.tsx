import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { isAskConfigured } from '@/lib/site/askReport'
import { sourcesFor } from '@/lib/reportBuilder/catalog'
import { PageHeader, PageBody, Card, Callout, Icons, EmptyState, ButtonLink } from '@/components/ui'
import AskPanel from './AskPanel'

export const dynamic = 'force-dynamic'

/**
 * Describe a report in plain English and have it built.
 *
 * The result is an ordinary builder spec, so anything generated here can be
 * opened in the builder, edited, saved, scheduled and exported like any other
 * report — the AI is a way to start one, not a separate kind of report.
 */
export default async function AskPage() {
  const { capabilities } = await requireCapability('reports.ai')
  const allow = (c: Parameters<typeof can>[1]) => can(capabilities, c)

  const configured = isAskConfigured()
  const sources = sourcesFor(allow)

  return (
    <>
      <PageHeader
        title="Generate a report"
        subtitle="Describe what you want to see and it will be built for you."
      />
      <PageBody>
        {!configured ? (
          <Card>
            <EmptyState
              title="Report generation is not set up"
              hint="An administrator needs to add an Anthropic API key before reports can be generated from a description."
              icon={<Icons.Sparkles size={28} strokeWidth={1.75} />}
              action={
                <ButtonLink href="/reports/builder" variant="primary">
                  Build one by hand instead
                </ButtonLink>
              }
            />
          </Card>
        ) : sources.length === 0 ? (
          <Card>
            <EmptyState
              title="No data available to you"
              hint="Generating a report needs access to at least one kind of data. An owner can grant this under Setup → Roles."
              icon={<Icons.Database size={28} strokeWidth={1.75} />}
            />
          </Card>
        ) : (
          <AskPanel
            canBuild={allow('reports.build')}
            examples={exampleQuestions(sources.map((s) => s.key))}
          />
        )}
      </PageBody>
    </>
  )
}

/**
 * Starter questions, filtered to data the user can actually read.
 *
 * A blank box is the worst possible prompt for this feature — most people
 * cannot guess what it will understand until they see one worked example.
 */
function exampleQuestions(sourceKeys: string[]): string[] {
  const has = (k: string) => sourceKeys.includes(k)
  const out: string[] = []

  if (has('saleLines')) {
    out.push('Top 10 products by profit last month')
    out.push('Sales by department this year, as a pie chart')
  }
  if (has('sales')) out.push('How many invoices did each cashier do last week?')
  if (has('products')) out.push('Products below their minimum stock level')
  if (has('customerTransactions')) out.push('Which customers owe us the most and for how long?')
  if (has('expenseLines')) out.push('What did we spend by category this month?')
  if (has('tenders')) out.push('How much did we take by card versus cash last week?')

  return out.slice(0, 5)
}

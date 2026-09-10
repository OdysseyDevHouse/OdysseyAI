'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Switch,
  TextLink,
  useToast,
} from '@/components/ui'
import { saveJobSettingsAction } from '../../actions'

/**
 * What has to be true before a job can be signed off.
 *
 * ── WHY THESE THREE ARE ONE SCREEN ─────────────────────────────────────────
 *
 * They are the close guard. Two of them decide what must be DONE before a job
 * can be closed, and the third decides what a customer is agreeing to when they
 * put their name to it. Somebody asking "why will this job not close?" and
 * somebody asking "what does our signature say?" are asking about the same
 * moment, and the answer to both was buried in a card called "Closing, parts,
 * telling people, and what happens on its own".
 *
 * ── THE SIGNATURE STATEMENT IS THE ONE THAT MATTERS ────────────────────────
 *
 * It is the only setting here with legal weight: it is the sentence a customer
 * is held to. So it is a required field rather than an optional one — the action
 * refuses an empty save — and it reads last, under its own heading, rather than
 * as a third switch in a list.
 */
export default function SignoffPanel({
  itemsBlockClose: initialItemsBlockClose,
  headlineRequired: initialHeadlineRequired,
  signatureStatement: initialStatement,
}: {
  itemsBlockClose: boolean
  headlineRequired: boolean
  signatureStatement: string
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [blockClose, setBlockClose] = useState(initialItemsBlockClose)
  const [needHeadline, setNeedHeadline] = useState(initialHeadlineRequired)
  const [statement, setStatement] = useState(initialStatement)

  function save() {
    start(async () => {
      // Only the three keys this screen owns. See the action for why a patch.
      const result = await saveJobSettingsAction({
        itemsBlockClose: blockClose,
        headlineRequired: needHeadline,
        signatureStatement: statement,
      })
      if (result.ok) {
        toast.success(result.message)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Card>
      <CardHeader
        title="Before a job can be signed off"
        description="What has to be done, and what the customer is putting their name to."
        action={
          <Button onClick={save} disabled={pending || !statement.trim()}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        }
      />
      <CardBody>
        <div className="space-y-6">
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              What has to be done first
            </p>
            <Switch
              checked={blockClose}
              onChange={setBlockClose}
              label="Required tasks and checks must be done"
              hint="A photo or signature check also needs its file, not just a tick."
            />
            <Switch
              checked={needHeadline}
              onChange={setNeedHeadline}
              label="Every job must say what kind of work it is"
              hint="Off by default — a job logged over the phone often does not know yet."
            />
            {/* A stage can overrule both of the above, and somebody who has just
                set them would not otherwise learn that. */}
            <p className="text-xs text-muted">
              A single stage can overrule the first of these — Cancelled usually should. Set that
              on the stage itself, under{' '}
              <TextLink href="/jobs/setup/statuses">Statuses</TextLink>.
            </p>
          </div>

          <div className="space-y-3 border-t border-border pt-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              What they are signing
            </p>
            <Field
              label="What a customer is agreeing to when they sign"
              hint="Shown above the signature pad. A mark with nothing stating what it means is not worth capturing."
              /* The only field here that can be wrong rather than merely off, so
                 it reports its own emptiness rather than waiting for the save to
                 refuse — the button is disabled and this says why. */
              error={statement.trim() ? undefined : 'A signature needs wording above it.'}
            >
              <Input
                value={statement}
                onChange={(e) => setStatement(e.target.value)}
                maxLength={400}
                disabled={pending}
              />
            </Field>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmModal,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@/components/ui'
import type { CustomFieldDef } from '@/lib/site/customFields'
import {
  ENTITY_LABEL,
  ENTITY_PLURAL,
  FIELD_ENTITIES,
  FIELD_TYPES,
  TYPE_LABEL,
  codeFromName,
  validateFieldDef,
  type CustomFieldEntity,
  type CustomFieldType,
} from '@/lib/customFieldModel'
import { saveFieldAction, deleteFieldAction, moveFieldAction } from './actions'

/**
 * The three sets of fields, and the one dialog that edits any of them.
 *
 * ── THE CODE IS SHOWN, NOT HIDDEN ──────────────────────────────────────────
 *
 * It is derived from the name and frozen at creation, so a user never types one.
 * But it IS what a report and an import name the field by, so hiding it would
 * make "which column is this in the export" unanswerable from the screen that
 * defines it.
 */
export default function FieldsClient({ fields }: { fields: CustomFieldDef[] }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [entity, setEntity] = useState<CustomFieldEntity>('job')
  const [editing, setEditing] = useState<CustomFieldDef | 'new' | null>(null)
  const [deleting, setDeleting] = useState<CustomFieldDef | null>(null)

  const [name, setName] = useState('')
  const [hint, setHint] = useState('')
  const [fieldType, setFieldType] = useState<CustomFieldType>('text')
  const [optionsText, setOptionsText] = useState('')
  const [unit, setUnit] = useState('')
  const [isRequired, setIsRequired] = useState(false)
  const [isPublic, setIsPublic] = useState(false)
  const [isActive, setIsActive] = useState(true)

  const shown = fields.filter((f) => f.entity === entity)

  function open(field: CustomFieldDef | 'new') {
    setEditing(field)
    if (field === 'new') {
      setName('')
      setHint('')
      setFieldType('text')
      setOptionsText('')
      setUnit('')
      setIsRequired(false)
      setIsPublic(false)
      setIsActive(true)
    } else {
      setName(field.name)
      setHint(field.hint ?? '')
      setFieldType(field.fieldType)
      setOptionsText(field.options.join('\n'))
      setUnit(field.unit ?? '')
      setIsRequired(field.isRequired)
      setIsPublic(field.isPublic)
      setIsActive(field.isActive)
    }
  }

  // One line per choice. A comma-separated box cannot hold a choice with a comma
  // in it, and "Repair, then return" is a perfectly ordinary thing to want.
  const options = optionsText
    .split('\n')
    .map((o) => o.trim())
    .filter(Boolean)

  const draft = {
    entity,
    code: editing === 'new' || editing === null ? codeFromName(name) : editing.code,
    name,
    hint: hint.trim() || null,
    fieldType,
    options,
    unit: unit.trim() || null,
    isRequired,
    isPublic,
    isActive,
  }
  // The same function the server calls, so the button explains the refusal
  // before it happens rather than after.
  const problem = name.trim() ? validateFieldDef(draft) : null

  // Changing the type of a field somebody has filled in is refused by the
  // server. Saying so here means the dropdown explains itself.
  const typeLocked = editing !== 'new' && editing !== null && editing.valueCount > 0

  function save() {
    start(async () => {
      const result = await saveFieldAction({
        ...draft,
        id: editing === 'new' || editing === null ? null : editing.id,
      })
      if (result.ok) {
        toast.success('Field saved.')
        setEditing(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function remove() {
    if (!deleting) return
    start(async () => {
      const result = await deleteFieldAction(deleting.id)
      if (result.ok) {
        toast.success(`"${deleting.name}" deleted.`)
        setDeleting(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function move(field: CustomFieldDef, direction: 'up' | 'down') {
    start(async () => {
      const result = await moveFieldAction(field.id, direction)
      if (result.ok) router.refresh()
      else toast.error(result.error)
    })
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Custom fields"
          description="Each set belongs to one kind of record. A job field appears on every job, a customer field on every customer."
          action={
            <Button variant="secondary" onClick={() => open('new')} disabled={pending}>
              <Icons.Plus size={15} />
              Add a field
            </Button>
          }
        />
        <CardBody className="p-0">
          <div className="border-b border-border px-4 py-3">
            <SegmentedControl
              value={entity}
              onChange={setEntity}
              options={FIELD_ENTITIES.map((e) => ({
                value: e,
                // The count is on the tab, so somebody can see where their
                // fields are without clicking through three empty sets.
                label: `${ENTITY_PLURAL[e]} (${fields.filter((f) => f.entity === e).length})`,
              }))}
            />
          </div>

          {shown.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<Icons.Tag size={22} />}
                title={`No extra fields on ${ENTITY_PLURAL[entity].toLowerCase()} yet`}
                hint="Worth one for anything this business records that the app does not already ask for — a warranty date, a meter reading, which round it belongs to."
              />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {shown.map((field, index) => (
                <li key={field.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-ink">{field.name}</span>
                      <Badge tone="neutral">{TYPE_LABEL[field.fieldType]}</Badge>
                      {field.isRequired && <Badge tone="warning">Required</Badge>}
                      {/* Named on the row, not buried in the dialog: which
                          fields a customer can see is the thing somebody scans
                          this list for. */}
                      {field.isPublic && <Badge tone="brand">Customer sees it</Badge>}
                      {!field.isActive && <Badge tone="neutral">Retired</Badge>}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {field.code}
                      {field.hint ? ` — ${field.hint}` : ''}
                      {field.valueCount > 0 ? ` · ${field.valueCount} filled in` : ''}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Move ${field.name} up`}
                    disabled={pending || index === 0}
                    onClick={() => move(field, 'up')}
                  >
                    <Icons.ChevronUp size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Move ${field.name} down`}
                    disabled={pending || index === shown.length - 1}
                    onClick={() => move(field, 'down')}
                  >
                    <Icons.ChevronDown size={15} />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => open(field)} disabled={pending}>
                    Edit
                  </Button>
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Delete ${field.name}`}
                    // Disabled rather than refused for a field holding answers:
                    // the server refuses it anyway, and a button that always
                    // errors is worse than one that explains why it is off.
                    disabled={pending || field.valueCount > 0}
                    title={
                      field.valueCount > 0
                        ? 'This field holds answers. Retire it instead.'
                        : undefined
                    }
                    onClick={() => setDeleting(field)}
                  >
                    <Icons.Trash size={15} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={
          editing === 'new'
            ? `Add a ${ENTITY_LABEL[entity].toLowerCase()} field`
            : 'Edit the field'
        }
        size="sm"
      /* A long form: the default 60vh cap made it read through a letterbox with
           empty desktop above and below. Still a MAX, so a short one stays short. */
        bodyGrows
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={pending || !name.trim() || problem !== null}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field
            label="What it is called"
            hint={
              editing === 'new' || editing === null
                ? `Saved as ${codeFromName(name) || '…'} — the name a report and an export use, fixed once created.`
                : `Saved as ${editing.code}. The name can change; this cannot.`
            }
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Warranty expires"
              maxLength={120}
            />
          </Field>

          <Field label="A hint, if it needs one" hint="Shown under the field on every record.">
            <Input
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="As printed on the unit"
              maxLength={190}
            />
          </Field>

          <Field
            label="What kind of thing it holds"
            hint={
              typeLocked
                ? `${editing.valueCount} record(s) already carry a value, so this is fixed. Add a new field instead.`
                : undefined
            }
          >
            <Select
              value={fieldType}
              onChange={(e) => setFieldType(e.target.value as CustomFieldType)}
              disabled={pending || typeLocked}
            >
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>

          {fieldType === 'list' && (
            <Field label="The choices" hint="One per line. At least two — with one it is not a choice.">
              <Textarea
                value={optionsText}
                onChange={(e) => setOptionsText(e.target.value)}
                rows={4}
                placeholder={'North\nSouth'}
              />
            </Field>
          )}

          {fieldType === 'number' && (
            <Field label="Its unit, if it has one" hint="Shown after the number — bar, km, hours.">
              <Input
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                placeholder="bar"
                maxLength={20}
              />
            </Field>
          )}

          <Switch
            checked={isRequired}
            onChange={setIsRequired}
            label="Must be filled in"
            hint="Records missing it are reported. It does not stop anybody saving."
          />

          <Switch
            checked={isPublic}
            onChange={setIsPublic}
            label="A customer may see this"
            hint="Off unless you say otherwise. Anything internal — a risk rating, a margin note — must stay off."
          />

          <Switch
            checked={isActive}
            onChange={setIsActive}
            label="In use"
            hint="Retire a field to take it off the forms while keeping every answer already given."
          />

          {/* The live refusal, in the dialog rather than as a toast after the
              press: the user is looking at the thing that is wrong. */}
          {problem && (
            <p className="text-xs text-danger" role="alert">
              {problem}
            </p>
          )}
        </div>
      </Modal>

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        title={`Delete ${deleting?.name ?? 'this field'}?`}
        confirmLabel="Delete it"
        tone="danger"
        busy={pending}
        message="Nothing has been filled in for this field, so nothing is lost. A field that holds answers cannot be deleted at all — it is retired instead."
      />
    </>
  )
}

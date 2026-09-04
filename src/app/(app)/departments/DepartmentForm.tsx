'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { Save } from '@/components/ui/icons'
import {
  Button,
  Callout,
  Field,
  FieldGroup,
  Input,
  NumberInput,
  Select,
  SwatchPicker,
  Switch,
} from '@/components/ui'
import PicturePicker from '@/components/PicturePicker'
import DepartmentTilePanel from '@/components/DepartmentTilePanel'
import { saveDepartmentAction, type DepartmentFormState } from './actions'
import type { StorefrontImage } from '@/lib/site/storefrontImages'
import type { Department } from '@/lib/site/departments'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" variant="primary" disabled={pending}>
      <Save size={15} />
      {pending ? 'Saving…' : 'Save department'}
    </Button>
  )
}

export default function DepartmentForm({
  department,
  parentOptions,
  defaultParentId,
  pictures,
}: {
  department: Department | null
  /** Every department this one may sit under — already excludes itself and its
   *  own descendants, which would detach the branch from the tree. */
  parentOptions: { id: number; label: string }[]
  defaultParentId: number | null
  /**
   * The two pictures this department already has, resolved server-side, so
   * each picker shows a thumbnail before its dialog has ever been opened.
   * Either may be null — for "none chosen" and for "the picture was deleted",
   * which are the same thing to everything downstream.
   */
  pictures: { pos: StorefrontImage | null; online: StorefrontImage | null }
}) {
  const [state, formAction] = useActionState<DepartmentFormState, FormData>(
    saveDepartmentAction,
    { error: null },
  )

  const [name, setName] = useState(department?.name ?? '')
  const [color, setColor] = useState(department?.color ?? '')
  const [active, setActive] = useState(department?.isActive ?? true)

  /*
   * The chosen pictures, as ids plus the resolved image for the thumbnail.
   *
   * Held together rather than as two pieces of state because they always
   * change together — the picker hands back the whole image, and an id without
   * its image would draw an empty box until the page revalidated.
   */
  const [posImage, setPosImage] = useState(pictures.pos)
  const [onlineImage, setOnlineImage] = useState(pictures.online)

  return (
    <form action={formAction} className="flex flex-col gap-5 p-5">
      {department && <input type="hidden" name="id" value={department.id} />}

      {state.error && (
        <Callout tone="danger" title="Could not save">
          {state.error}
        </Callout>
      )}

      <FieldGroup title="Identity" hint="What it is called and where it sits in the tree.">
        {/*
          The name takes the full width now that the code is not asked for.

          The code is a reporting reference the app allocates — the next free
          number, and the parent's plus ".n" underneath it — so typing one was
          a question with a right answer the app already knew. Left to a person
          it got skipped, and a report grouping by code silently split. It is
          still SHOWN, because a shop that has printed it on a shelf label
          needs to read it back; it is just no longer theirs to invent.
        */}
        {/* Controlled rather than defaultValue: the till preview below renames
            as this is typed, which an uncontrolled input cannot drive. */}
        <Field label="Name">
          <Input
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            autoFocus
          />
        </Field>

        <Field label="Sits under">
          <Select
            name="parentId"
            defaultValue={department ? (department.parentId ?? '') : (defaultParentId ?? '')}
          >
            <option value="">&lt;Top level&gt;</option>
            {parentOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </FieldGroup>

      <FieldGroup title="Presentation" hint="How it appears on tiles and in lists.">
        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink-2">Colour</span>
          <SwatchPicker value={color} onChange={(next) => setColor(next ?? '')} size="sm" />
          <p className="mt-1.5 text-xs text-muted">
            Optional — shown on the department&rsquo;s tile in lists and pickers.
          </p>
          <input type="hidden" name="color" value={color} />
        </div>

        {/*
          Two pictures, side by side and clearly labelled, because the whole
          point is that they are DIFFERENT pictures for different jobs — see
          064_department_images.sql. Put one above the other and they read as
          "the picture" and "the other picture", which is how a shop ends up
          with a wide storefront photograph squeezed into a 40px till tile.

          Both draw from the same library as the front page's banners, so a
          picture uploaded here can be reused there and the other way round.
        */}
        <div className="grid gap-4 sm:grid-cols-2">
          {/* The till icon is chosen ON the preview now, the way the product
              form does it: the picture's whole job is to read at 40px on a
              coloured disc across a counter, and a 112px thumbnail beside a
              caption promising that was the one thing the old control could not
              show. The hint it used to carry is gone with it — the tile answers
              "what works at that size" by being the size. */}
          <DepartmentTilePanel
            departmentId={department?.id ?? null}
            name={name}
            posImage={posImage}
            onPosImageChange={setPosImage}
            childCount={department?.childCount ?? 0}
            productCount={department?.productCount ?? 0}
          />

          <Field
            label="Online store picture"
            hint="Shown in your shop, if you have switched department pictures on under Online Store → Setup."
          >
            <PicturePicker
              value={onlineImage?.id ?? null}
              current={onlineImage}
              onChange={setOnlineImage}
            />
          </Field>
        </div>
        <input type="hidden" name="posImageId" value={posImage?.id ?? ''} />
        <input type="hidden" name="onlineImageId" value={onlineImage?.id ?? ''} />

        <Field
          label="Sort order"
          hint="Lower numbers list first."
          className="max-w-40"
        >
          <NumberInput name="sortOrder" precision={0} defaultValue={department?.sortOrder ?? 0} />
        </Field>

        {/* The save action reads the old checkbox contract: 'on' means active,
            anything else means inactive — so the switch submits exactly that. */}
        <input type="hidden" name="isActive" value={active ? 'on' : ''} />
        <Switch
          checked={active}
          onChange={setActive}
          label="Active"
          hint="Switch off to hide it from pickers without touching its products."
        />
      </FieldGroup>

      <div className="flex items-center border-t border-border pt-4">
        <SubmitButton />
      </div>
    </form>
  )
}

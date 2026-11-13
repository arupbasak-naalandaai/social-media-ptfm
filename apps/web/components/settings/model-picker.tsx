"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronsUpDown, PenLine, RefreshCw } from "lucide-react"
import type { AiModelOption, AiProvider } from "@inbox/core"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import { qk } from "@/lib/query-keys"
import { cn } from "cn"

/**
 * Model ID picker: the provider's live model list (fetched by the api with the typed or saved
 * key, against the typed or saved endpoint), searchable, plus "use what I typed" for any ID
 * the list doesn't have.
 */
export function ModelPicker({
  id,
  provider,
  value,
  onChange,
  onBlur,
  invalid,
  placeholder,
  typedKey,
  keySaved,
  baseUrl,
}: {
  id: string
  provider: AiProvider
  value: string
  onChange: (value: string) => void
  onBlur: () => void
  invalid: boolean
  placeholder: string
  typedKey: string | undefined
  keySaved: boolean
  baseUrl: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const apiKey = typedKey?.trim() || undefined
  const canLoad = provider === "openrouter" || keySaved || Boolean(apiKey)

  const models = useQuery({
    queryKey: qk.aiModels(provider, baseUrl.trim(), apiKey ?? null),
    queryFn: () =>
      api<{ models: AiModelOption[] }>("/settings/ai/models", {
        method: "POST",
        body: { provider, baseUrl: baseUrl.trim(), ...(apiKey ? { apiKey } : {}) },
      }).then((r) => r.models),
    enabled: open && canLoad,
    staleTime: 10 * 60_000,
    retry: false,
  })

  const typed = search.trim()
  const list = models.data ?? []
  const showCustom = typed !== "" && !list.some((m) => m.id === typed)
  const pick = (next: string) => {
    onChange(next)
    setOpen(false)
    setSearch("")
    onBlur()
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setSearch("")
          onBlur()
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-invalid={invalid || undefined}
            className="w-full justify-between font-normal"
          />
        }
      >
        <span className={cn("truncate font-mono text-sm", !value && "text-muted-foreground")}>
          {value || placeholder}
        </span>
        <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--anchor-width) min-w-80 gap-0 p-0">
        <Command loop>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder="Search models or type an ID…"
          />
          <CommandList>
            {showCustom ? (
              <CommandGroup>
                <CommandItem value={`__custom__ ${typed}`} forceMount onSelect={() => pick(typed)}>
                  <PenLine />
                  <span className="truncate">
                    Use <span className="font-mono">{typed}</span>
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {!canLoad ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Add an API key to load this provider’s models, or type a model ID above.
              </p>
            ) : models.isPending ? (
              <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Spinner /> Loading models…
              </p>
            ) : models.isError ? (
              <p role="alert" className="px-3 py-4 text-sm break-words text-destructive">
                {models.error instanceof Error ? models.error.message : "Couldn’t load models"}
              </p>
            ) : (
              <>
                {!showCustom ? <CommandEmpty>No models match.</CommandEmpty> : null}
                <CommandGroup heading={`${list.length} models, newest first`}>
                  {list.map((m) => (
                    <CommandItem
                      key={m.id}
                      value={m.id}
                      keywords={m.name ? [m.name] : []}
                      data-checked={m.id === value}
                      onSelect={() => pick(m.id)}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-mono text-xs">{m.id}</span>
                        {m.name || m.created ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {[m.name, m.created?.slice(0, 10)].filter(Boolean).join(" · ")}
                          </span>
                        ) : null}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
          {canLoad ? (
            <div className="flex items-center justify-end border-t p-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={models.isFetching}
                onClick={() => void models.refetch()}
              >
                <RefreshCw className={cn(models.isFetching && "animate-spin")} />
                Refresh list
              </Button>
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-lg border border-transparent bg-muted px-2 py-0.5 font-sans text-caption font-medium whitespace-nowrap transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "text-foreground",
        secondary: "bg-soft-stone text-graphite",
        destructive:
          "bg-chalk text-destructive focus-visible:ring-destructive/20",
        outline: "border-mist bg-transparent text-graphite",
        ghost: "bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
        link:
          "rounded-none bg-transparent px-0 text-graphite underline underline-offset-4 hover:text-carbon-ink",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }

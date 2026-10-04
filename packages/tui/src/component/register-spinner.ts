import { getComponentCatalogue } from "@opentui/solid/components"
import { registerSpinner } from "opentui-spinner/solid"

export function registerOrbitSpinner() {
  if (!getComponentCatalogue().spinner) registerSpinner()
}

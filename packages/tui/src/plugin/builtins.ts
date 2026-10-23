import HomeFooter from "../feature-plugins/home/footer"
import PromptBtw from "../feature-plugins/prompt/btw"
import PromptFooter from "../feature-plugins/prompt/footer"
import PromptTrust from "../feature-plugins/prompt/trust"
import SidebarContext from "../feature-plugins/sidebar/context"
import SidebarFooter from "../feature-plugins/sidebar/footer"
import SidebarMcp from "../feature-plugins/sidebar/mcp"
import DiffViewer from "../feature-plugins/system/diff-viewer"
import Notifications from "../feature-plugins/system/notifications"
import Recap from "../feature-plugins/session/recap"
import Plugins from "../feature-plugins/system/plugins"
import Storybook from "../feature-plugins/system/storybook"
import Stats from "../feature-plugins/system/stats"
import Latex from "@orbit/latex/plugin"
import Merman from "@orbit/merman/plugin"

export const builtins = [
  HomeFooter,
  PromptFooter,
  PromptTrust,
  PromptBtw,
  SidebarContext,
  SidebarMcp,
  SidebarFooter,
  Notifications,
  Recap,
  Plugins,
  Stats,
  Merman,
  Latex,
  // The storybook is a development tool; keep its route and palette commands out of
  // normal launches and register it only for ORBIT_STORY runs.
  ...(process.env.ORBIT_STORY ? [Storybook] : []),
  DiffViewer,
]

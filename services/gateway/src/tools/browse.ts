import type { ToolDefinition } from '../providers/types.ts';

/**
 * Browsing, offered to every surface.
 *
 * The browsing agent is a local subprocess on the user's machine, so the
 * gateway cannot call it — traffic goes the other way. What the gateway can do
 * is *declare* the tool, so a model on any surface can ask for a browse, and
 * let the caller that owns a browser run it and send the result back.
 *
 * That keeps one definition in one place. Without it, chat would describe a
 * search it cannot do while the task agent quietly could, and the two surfaces
 * would disagree about what Aira is capable of.
 */

export const BROWSE_TOOL: ToolDefinition = {
  name: 'browse_web',
  description:
    'Open and read web pages to answer a question that needs current or external ' +
    'information. Use it for anything you would otherwise guess at: prices, news, ' +
    'documentation, release notes, whether something still exists. Give a complete ' +
    'instruction, not a search query — "find the latest Tauri release and summarise ' +
    'the breaking changes" rather than "tauri release".',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'What to find out, written as an instruction.',
      },
      maxSteps: {
        type: 'number',
        description: 'Page actions to allow. Default 12. Raise only for genuinely multi-page research.',
      },
    },
    required: ['task'],
  },
};

/**
 * Whether a caller can actually perform a browse.
 *
 * Declared only when the caller says it has a browser. Offering a tool nothing
 * can run produces a model that announces it is searching the web and then
 * returns an invented answer — worse than not having the tool at all.
 */
export function browseTools(canBrowse: boolean): ToolDefinition[] {
  return canBrowse ? [BROWSE_TOOL] : [];
}

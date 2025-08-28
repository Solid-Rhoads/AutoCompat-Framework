import { ITemplateItem } from "@spt/models/eft/common/tables/ITemplateItem";
import { ModConfig } from "../references/types";

export interface ConflictResults 
{
    numBaseConflictsAdded: number;
    numClonedConflictsAdded: number;
    numConflictsVoided: number;
}

export function handleConflicts(
    items: Record<string, ITemplateItem>,
    config: ModConfig,
    baseToClones: Map<string, string[]>,
    locales: Record<string, string>,
    logMessage: (level: "info" | "warning" | "debug" | "success", message: string, verboseOnly?: boolean, verboseLogging?: boolean, color?: string) => void,
    itemsToProcessForConflicts: [string, string][],
    modifiedItemsThisPass: Set<string>,
    numBaseConflictsAdded: number,
    numClonedConflictsAdded: number,
    numConflictsVoided: number
): ConflictResults 
{
    for (const [moddedId, baseId] of itemsToProcessForConflicts) 
    {
        if (config.blacklist.includes(moddedId)) continue;
        const baseConflicts = items[baseId]._props.ConflictingItems || [];
        const moddedConflicts = items[moddedId]._props.ConflictingItems || [];

        if (config.inheritBaseConflicts) 
        {
            for (const baseConflictId of baseConflicts) 
            {
                if (config.VoidConflicts.includes(baseConflictId)) 
                {
                    logMessage("debug", `Skipped adding base conflict ${baseConflictId} (${locales[`${baseConflictId} Name`] || "Unknown"}) to modded item ${moddedId} (${locales[`${moddedId} Name`] || "Unknown"}): in VoidConflicts`, true, config.verboseLogging);
                    numConflictsVoided++;
                    continue;
                }
                if (!moddedConflicts.includes(baseConflictId)) 
                {
                    moddedConflicts.push(baseConflictId);
                    modifiedItemsThisPass.add(moddedId);
                    logMessage("info", `Added base conflict ${baseConflictId} (${locales[`${baseConflictId} Name`] || "Unknown"}) to modded item ${moddedId} (${locales[`${moddedId} Name`] || "Unknown"})`, true, config.verboseLogging);
                    numBaseConflictsAdded++;
                }
                else 
                {
                    logMessage("debug", `Skipped adding base conflict ${baseConflictId} (${locales[`${baseConflictId} Name`] || "Unknown"}) to modded item ${moddedId} (${locales[`${moddedId} Name`] || "Unknown"}): already exists`, true, config.verboseLogging);
                }
            }
        }
        else 
        {
            logMessage("debug", "Skipped base conflict inheritance due to inheritBaseConflicts: false", true, config.verboseLogging);
        }

        if (config.inheritCloneConflicts) 
        {
            for (const baseConflictId of baseConflicts) 
            {
                if (baseToClones.has(baseConflictId)) 
                {
                    const clones = baseToClones.get(baseConflictId)!.filter(id => !config.blacklist.includes(id));
                    for (const cloneId of clones) 
                    {
                        if (config.VoidConflicts.includes(cloneId)) 
                        {
                            logMessage("debug", `Skipped adding cloned conflict ${cloneId} (${locales[`${cloneId} Name`] || "Unknown"}) to modded item ${moddedId} (${locales[`${moddedId} Name`] || "Unknown"}): in VoidConflicts`, true, config.verboseLogging);
                            numConflictsVoided++;
                            continue;
                        }
                        if (!moddedConflicts.includes(cloneId)) 
                        {
                            moddedConflicts.push(cloneId);
                            modifiedItemsThisPass.add(moddedId);
                            logMessage("info", `Added cloned conflict ${cloneId} (${locales[`${cloneId} Name`] || "Unknown"}) to modded item ${moddedId} (${locales[`${moddedId} Name`] || "Unknown"})`, true, config.verboseLogging);
                            numClonedConflictsAdded++;
                        }
                        else 
                        {
                            logMessage("debug", `Skipped adding cloned conflict ${cloneId} (${locales[`${cloneId} Name`] || "Unknown"}): already exists`, true, config.verboseLogging);
                        }
                    }
                }
            }
        }
        else 
        {
            logMessage("debug", "Skipped cloned conflict inheritance due to inheritCloneConflicts: false", true, config.verboseLogging);
        }

        items[moddedId]._props.ConflictingItems = moddedConflicts;
    }

    return {
        numBaseConflictsAdded,
        numClonedConflictsAdded,
        numConflictsVoided
    };
}
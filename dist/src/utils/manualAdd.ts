import { BaseClasses } from "@spt/models/enums/BaseClasses";
import { ItemHelper } from "@spt/helpers/ItemHelper";
import { Item, Slot, ModConfig } from "../references/types";
import { LogTextColor } from "@spt/models/spt/logging/LogTextColor";

interface CommonModType 
{
    slot: string;
    base: string;
}

export function processManualAdd(
    config: ModConfig,
    items: Record<string, Item>,
    itemSlots: Map<string, Map<string, string[]>>,
    itemHelper: ItemHelper,
    locales: Record<string, string>,
    logMessage: (level: "info" | "warning" | "debug" | "success", message: string, verboseOnly?: boolean, verboseLogging?: boolean, color?: LogTextColor | string) => void,
    itemToBase: Map<string, string>,
    allItems: Item[],
    passNumber: number,
    modifiedItemsThisPass: Set<string>,
    numManualAdditions: number
): number 
{
    const commonModTypes: CommonModType[] = [
        { slot: "mod_foregrip", base: BaseClasses.FOREGRIP },
        { slot: "mod_scope", base: BaseClasses.OPTIC_SCOPE },
        { slot: "mod_magazine", base: BaseClasses.MAGAZINE },
        { slot: "mod_muzzle", base: BaseClasses.MUZZLE },
        { slot: "mod_stock", base: BaseClasses.STOCK },
        { slot: "mod_barrel", base: BaseClasses.BARREL },
        { slot: "mod_handguard", base: BaseClasses.HANDGUARD },
        { slot: "mod_launcher", base: BaseClasses.UBGL },
        { slot: "mod_tactical", base: BaseClasses.MOUNT },
        { slot: "mod_tactical", base: BaseClasses.FLASHLIGHT },
        { slot: "mod_tactical", base: BaseClasses.LIGHT_LASER_DESIGNATOR },
        { slot: "mod_tactical", base: BaseClasses.TACTICAL_COMBO },
        { slot: "mod_bipod", base: BaseClasses.BIPOD },
        { slot: "mod_muzzle", base: BaseClasses.COMPENSATOR },
        { slot: "mod_muzzle", base: BaseClasses.SILENCER },
        { slot: "mod_pistol_grip", base: BaseClasses.PISTOL_GRIP },
        { slot: "mod_receiver", base: BaseClasses.RECEIVER },
        { slot: "mod_charge", base: BaseClasses.CHARGING_HANDLE },
        { slot: "mod_gas_block", base: BaseClasses.GAS_BLOCK },
        { slot: "mod_tactical", base: BaseClasses.RAIL_COVER },
        { slot: "mod_sight_rear", base: BaseClasses.SIGHTS },
        { slot: "mod_sight_front", base: BaseClasses.SIGHTS },
        { slot: "mod_scope", base: BaseClasses.ASSAULT_SCOPE },
        { slot: "mod_muzzle", base: BaseClasses.FLASH_HIDER },
        { slot: "mod_scope", base: BaseClasses.COLLIMATOR },
        { slot: "mod_sight_rear", base: BaseClasses.IRON_SIGHT },
        { slot: "mod_sight_front", base: BaseClasses.IRON_SIGHT },
        { slot: "mod_scope", base: BaseClasses.COMPACT_COLLIMATOR },
        { slot: "mod_muzzle", base: BaseClasses.COMB_MUZZLE_DEVICE }
    ];

    const validateSlot = (item: Item, slot: Slot, type: string): boolean => 
    {
        if (!slot._name || typeof slot._name !== "string") 
        {
            logMessage("warning", `Item ${item._id} (${locales[`${item._id} Name`] || "Unknown"}): ${type} slot missing _name or _name is not a string`, true, config.verboseLogging);
            return false;
        }
        const filter = slot._props?.filters?.[0]?.Filter || [];
        if (!Array.isArray(filter)) 
        {
            logMessage("warning", `Item ${item._id} (${locales[`${item._id} Name`] || "Unknown"}): ${type} slot ${slot._name} has invalid or missing filters`, true, config.verboseLogging);
            return false;
        }
        return true;
    };

    for (const manual of config.ManualAdd || []) 
    {
        const attachmentIds = Array.isArray(manual.attachmentIds) ? manual.attachmentIds : [manual.attachmentIds];
        const targetItemIds = Array.isArray(manual.targetItemIds) ? manual.targetItemIds : [manual.targetItemIds];

        if (attachmentIds.length === 0 || targetItemIds.length === 0) 
        {
            logMessage("warning", `Pass ${passNumber}: Invalid ManualAdd entry: ${JSON.stringify(manual)}`, true, config.verboseLogging);
            continue;
        }

        for (const attachmentId of attachmentIds) 
        {
            if (!attachmentId) 
            {
                logMessage("warning", `Pass ${passNumber}: Invalid attachmentId in ManualAdd entry: ${JSON.stringify(manual)}`, true, config.verboseLogging);
                continue;
            }
            if (!items[attachmentId]) 
            {
                logMessage("warning", `Pass ${passNumber}: ManualAdd attachmentId ${attachmentId} not found in database`, true, config.verboseLogging);
                continue;
            }
            if (!itemHelper.isOfBaseclass(attachmentId, BaseClasses.MOD) && !itemHelper.isOfBaseclass(attachmentId, BaseClasses.AMMO)) 
            {
                logMessage("warning", `Pass ${passNumber}: ManualAdd attachmentId ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) is neither a mod nor ammo`, true, config.verboseLogging);
                continue;
            }
            if (config.blacklist.includes(attachmentId)) 
            {
                logMessage("debug", `Pass ${passNumber}: Skipped ManualAdd attachment ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}): in blacklist`, true, config.verboseLogging);
                continue;
            }

            for (const targetItemId of targetItemIds) 
            {
                if (!targetItemId) 
                {
                    logMessage("warning", `Pass ${passNumber}: Invalid targetItemId in ManualAdd entry: ${JSON.stringify(manual)}`, true, config.verboseLogging);
                    continue;
                }
                if (!items[targetItemId]) 
                {
                    logMessage("warning", `Pass ${passNumber}: ManualAdd targetItemId ${targetItemId} not found in database`, true, config.verboseLogging);
                    continue;
                }
                if (config.blacklist.includes(targetItemId)) 
                {
                    logMessage("debug", `Pass ${passNumber}: Skipped ManualAdd to target ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}): in blacklist`, true, config.verboseLogging);
                    continue;
                }

                if (config.verboseLogging) 
                {
                    const attachment = items[attachmentId];
                    logMessage("debug", `Pass ${passNumber}: ManualAdd attachment ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) has _parent: ${attachment._parent || "None"}`, true, config.verboseLogging);
                    logMessage("debug", `Pass ${passNumber}: ManualAdd attachment ${attachmentId} base classes: ${[BaseClasses.MOD, BaseClasses.AMMO].filter(base => itemHelper.isOfBaseclass(attachmentId, base)).join(", ") || "None"}`, true, config.verboseLogging);
                    const targetSlots = itemSlots.get(targetItemId) || new Map<string, string[]>();
                    logMessage("debug", `Pass ${passNumber}: Target item ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}) available slots: ${Array.from(targetSlots.keys()).join(", ") || "None"}`, true, config.verboseLogging);
                }

                let slotName: string | null = null;
                let targetFilter: string[] | null = null;
                const targetItem = items[targetItemId];
                const attachment = items[attachmentId];

                if (itemHelper.isOfBaseclass(attachmentId, BaseClasses.AMMO)) 
                {
                    if (itemHelper.isOfBaseclass(targetItemId, BaseClasses.WEAPON)) 
                    {
                        const chambers = targetItem._props.Chambers || [];
                        if (chambers.length > 0 && validateSlot(targetItem, chambers[0], "Chambers")) 
                        {
                            slotName = chambers[0]._name;
                            targetFilter = chambers[0]._props!.filters![0].Filter;
                            logMessage("debug", `Pass ${passNumber}: Using Chambers slot ${slotName} for weapon ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"})`, true, config.verboseLogging);
                        }
                    }
                    else if (itemHelper.isOfBaseclass(targetItemId, BaseClasses.MAGAZINE)) 
                    {
                        const cartridges = targetItem._props.Cartridges || [];
                        if (cartridges.length > 0 && validateSlot(targetItem, cartridges[0], "Cartridges")) 
                        {
                            slotName = cartridges[0]._name;
                            targetFilter = cartridges[0]._props!.filters![0].Filter;
                            logMessage("debug", `Pass ${passNumber}: Using Cartridges slot ${slotName} for magazine ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"})`, true, config.verboseLogging);
                        }
                    }
                }
                else if (itemHelper.isOfBaseclass(attachmentId, BaseClasses.MAGAZINE)) 
                {
                    const targetSlots = itemSlots.get(targetItemId) || new Map<string, string[]>();
                    const magazineSlot = targetSlots.get("mod_magazine");
                    if (magazineSlot) 
                    {
                        const magazineCalibers = new Set<string>();
                        const cartridges = attachment._props.Cartridges || [];
                        for (const cartridge of cartridges) 
                        {
                            if (validateSlot(attachment, cartridge, "Cartridges")) 
                            {
                                for (const ammoId of cartridge._props!.filters![0].Filter) 
                                {
                                    const ammoCaliber = (items[ammoId]?._props.Caliber || "").toLowerCase();
                                    if (ammoCaliber) magazineCalibers.add(ammoCaliber);
                                }
                            }
                        }
                        const targetCaliber = (targetItem._props.ammoCaliber || "").toLowerCase();
                        if (magazineCalibers.has(targetCaliber)) 
                        {
                            slotName = "mod_magazine";
                            targetFilter = magazineSlot;
                            logMessage("debug", `Pass ${passNumber}: Matched magazine ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) to ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}) mod_magazine slot via caliber ${targetCaliber}`, true, config.verboseLogging);
                        }
                    }
                }
                else 
                {
                    const targetSlots = itemSlots.get(targetItemId) || new Map<string, string[]>();
                    const baseId = itemToBase.get(attachmentId);
                    const compatibleSlots: string[] = [];

                    if (baseId) 
                    {
                        for (const item of allItems) 
                        {
                            const slots = [...(item._props.Slots || []), ...(item._props.Chambers || []), ...(item._props.Cartridges || [])];
                            for (const slot of slots) 
                            {
                                if (validateSlot(item, slot, "Slots/Chambers/Cartridges") && slot._props?.filters?.[0]?.Filter.includes(baseId)) 
                                {
                                    if (!compatibleSlots.includes(slot._name.toLowerCase())) 
                                    {
                                        compatibleSlots.push(slot._name.toLowerCase());
                                    }
                                }
                            }
                        }
                        if (config.verboseLogging && compatibleSlots.length > 0) 
                        {
                            logMessage("debug", `Pass ${passNumber}: Clone-based slot inference for attachment ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) using base ${baseId} (${locales[`${baseId} Name`] || "Unknown"}): compatible slots [${compatibleSlots.join(", ")}]`, true, config.verboseLogging);
                        }
                    }

                    for (const type of commonModTypes) 
                    {
                        if (itemHelper.isOfBaseclass(attachmentId, type.base)) 
                        {
                            slotName = type.slot;
                            targetFilter = targetSlots.get(type.slot.toLowerCase()) || [];
                            if (targetFilter.length > 0) 
                            {
                                logMessage("debug", `Pass ${passNumber}: Matched attachment ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) to ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}) slot ${slotName} via base class ${type.base}`, true, config.verboseLogging);
                                break;
                            }
                        }
                    }

                    if (!slotName && compatibleSlots.length > 0) 
                    {
                        for (const possibleSlot of compatibleSlots) 
                        {
                            if (targetSlots.has(possibleSlot)) 
                            {
                                slotName = possibleSlot;
                                targetFilter = targetSlots.get(possibleSlot) || [];
                                logMessage("debug", `Pass ${passNumber}: Matched attachment ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) to ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}) slot ${slotName} via clone-based inference from base ${baseId} (${locales[`${baseId} Name`] || "Unknown"})`, true, config.verboseLogging);
                                break;
                            }
                        }
                    }

                    if (!slotName) 
                    {
                        for (const [possibleSlot, filter] of targetSlots) 
                        {
                            if (possibleSlot.match(/^mod_tactical(_\d{3})?$/)) 
                            {
                                if (itemHelper.isOfBaseclass(attachmentId, BaseClasses.MOUNT) ||
                                    itemHelper.isOfBaseclass(attachmentId, BaseClasses.FLASHLIGHT) ||
                                    itemHelper.isOfBaseclass(attachmentId, BaseClasses.LIGHT_LASER_DESIGNATOR) ||
                                    itemHelper.isOfBaseclass(attachmentId, BaseClasses.TACTICAL_COMBO) ||
                                    itemHelper.isOfBaseclass(attachmentId, BaseClasses.RAIL_COVER)) 
                                {
                                    slotName = possibleSlot;
                                    targetFilter = filter;
                                    logMessage("debug", `Pass ${passNumber}: Matched attachment ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) to ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}) slot ${slotName} via dynamic tactical slot matching`, true, config.verboseLogging);
                                    break;
                                }
                                else if (baseId && filter.includes(baseId)) 
                                {
                                    slotName = possibleSlot;
                                    targetFilter = filter;
                                    logMessage("debug", `Pass ${passNumber}: Matched attachment ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) to ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}) slot ${slotName} via base item ${baseId} in tactical slot filter`, true, config.verboseLogging);
                                    break;
                                }
                            }
                        }
                    }

                    if (!slotName) 
                    {
                        const attachmentSlots = attachment._props.Slots || [];
                        if (attachmentSlots.length > 0 && validateSlot(attachment, attachmentSlots[0], "Slots")) 
                        {
                            slotName = attachmentSlots[0]._name;
                            targetFilter = targetSlots.get(slotName.toLowerCase()) || [];
                            logMessage("debug", `Pass ${passNumber}: Fallback to attachment slot ${slotName} for ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) on ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"})`, true, config.verboseLogging);
                        }
                    }
                }

                if (!slotName || !targetFilter) 
                {
                    logMessage("warning", `Pass ${passNumber}: No valid slot found for attachment ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) on target item ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"})`, true, config.verboseLogging);
                    continue;
                }

                logMessage("debug", `Pass ${passNumber}: Processing ManualAdd ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) to ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}) slot ${slotName}, current filter: [${targetFilter.join(", ")}]`, true, config.verboseLogging);

                if (!targetFilter.includes(attachmentId)) 
                {
                    targetFilter.push(attachmentId);
                    modifiedItemsThisPass.add(targetItemId);
                    logMessage("info", `Pass ${passNumber}: Manually added attachment ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) to ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}) slot ${slotName}`, true, config.verboseLogging);
                    numManualAdditions++;
                }
                else 
                {
                    logMessage("debug", `Pass ${passNumber}: Skipped ManualAdd ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) to ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}) slot ${slotName}: already included in filter [${targetFilter.join(", ")}]`, true, config.verboseLogging);
                }
            }
        }
    }

    return numManualAdditions;
}
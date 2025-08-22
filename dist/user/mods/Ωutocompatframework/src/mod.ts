import path from "node:path";
import { DependencyContainer } from "tsyringe";
import { IPostDBLoadMod } from "@spt/models/external/IPostDBLoadMod";
import { DatabaseServer } from "@spt/servers/DatabaseServer";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { FileSystemSync } from "@spt/utils/FileSystemSync";
import { BaseClasses } from "@spt/models/enums/BaseClasses";
import { ItemHelper } from "@spt/helpers/ItemHelper";
import { LogTextColor } from "@spt/models/spt/logging/LogTextColor";
import { jsonc } from "jsonc";

interface Item 
{
    _id: string;
    _name?: string;
    _props: {
        Prefab?: { path: string; rcid: string };
        Name?: string;
        Caliber?: string;
        ammoCaliber?: string;
        Slots?: Slot[];
        Chambers?: Slot[];
        Cartridges?: Slot[];
        ConflictingItems?: string[];
    };
}

interface Slot 
{
    _name: string;
    _props?: { filters?: Array<{ Filter: string[] }> };
}

interface ModConfig 
{
    enabled: boolean;
    verboseLogging: boolean;
    secondPass: boolean;
    blacklist: string[];
    whitelist: string[];
    VoidConflicts: string[];
    inheritBaseConflicts: boolean;
    inheritCloneConflicts: boolean;
    ManualAdd: Array<{ attachmentId: string; targetItemId: string }>;
}

interface PassResult 
{
    numAmmoToChambers: number;
    numAmmoToCartridges: number;
    numAttachmentsToSlots: number;
    numBaseConflictsAdded: number;
    numClonedConflictsAdded: number;
    numConflictsVoided: number;
    numManualAdditions: number;
    modifiedItems: Set<string>;
}

class AutoCompatFramework implements IPostDBLoadMod 
{
    public postDBLoad(container: DependencyContainer): void 
    {
        const logger = container.resolve<ILogger>("WinstonLogger");
        const fileSystem = container.resolve<FileSystemSync>("FileSystemSync");

        let config: ModConfig;
        try 
        {
            config = jsonc.parse(fileSystem.read(path.resolve(__dirname, "../config/config.jsonc")));
        }
        catch (error) 
        {
            logger.error(`AutoCompatFramework: Failed to parse config.jsonc: ${error.message}`);
            return;
        }

        if (!config.enabled) 
        {
            logger.info("AutoCompatFramework disabled in config.jsonc");
            return;
        }

        if (config.verboseLogging) 
        {
            logger.debug(`Loaded config: ${JSON.stringify(config, null, 2)}`);
        }

        const databaseServer = container.resolve<DatabaseServer>("DatabaseServer");
        const itemHelper = container.resolve<ItemHelper>("ItemHelper");
        const items = databaseServer.getTables().templates.items;
        const locales = databaseServer.getTables().locales.global["en"];

        const weaponBaseClasses = [BaseClasses.WEAPON];
        const attachmentBaseClasses = [BaseClasses.MOD, BaseClasses.AMMO];

        const logMessage = (
            level: "info" | "warning" | "debug" | "success",
            message: string,
            verboseOnly: boolean = false,
            color?: LogTextColor
        ) => 
        {
            if (verboseOnly && !config.verboseLogging) return;
            if (level === "success") 
            {
                logger.success(message);
            }
            else if (level === "debug") 
            {
                logger.debug(message);
            }
            else if (level === "warning") 
            {
                logger.warning(message);
            }
            else if (color) 
            {
                logger.logWithColor(message, color);
            }
            else 
            {
                logger.info(message);
            }
        };

        const processCompatibility = (passNumber: number, modifiedItems?: Set<string>): PassResult => 
        {
            const allItems = Object.values(items);
            const allWeapons = allItems.filter(x => weaponBaseClasses.some(base => itemHelper.isOfBaseclass(x._id, base)));
            const allAttachments = allItems.filter(x => attachmentBaseClasses.some(base => itemHelper.isOfBaseclass(x._id, base)));
            const allAmmo = allItems.filter(x => itemHelper.isOfBaseclass(x._id, BaseClasses.AMMO));

            const moddedWeapons = allWeapons.filter(x => !x._props?.Prefab?.path.startsWith("assets/content/"));
            const moddedAttachments = allAttachments.filter(x => !x._props?.Prefab?.path.startsWith("assets/content/"));
            const moddedAmmo = allAmmo.filter(x => !x._props?.Prefab?.path.startsWith("assets/content/"));

            const itemToBase = new Map<string, string>();
            const baseToClones = new Map<string, string[]>();
            const caliberToAmmo = new Map<string, string[]>();

            const findBaseId = (item: Item): string | null => 
            {
                const name = item._name || item._props?.Name || item._id;
                for (const [id, dbItem] of Object.entries(items)) 
                {
                    if ((dbItem._name === name || dbItem._props?.Name === name) && dbItem._props?.Prefab?.path.startsWith("assets/content/")) 
                    {
                        return id;
                    }
                }
                logMessage("warning", `Modded item ${item._id} (${locales[`${item._id} Name`] || "Unknown"}): No base item found for clone mapping`, true);
                return null;
            };

            const buildCloneMaps = (moddedList: Item[]) => 
            {
                for (const moddedItem of moddedList) 
                {
                    const baseId = findBaseId(moddedItem);
                    if (baseId) 
                    {
                        itemToBase.set(moddedItem._id, baseId);
                        if (!baseToClones.has(baseId)) baseToClones.set(baseId, []);
                        baseToClones.get(baseId)!.push(moddedItem._id);
                    }
                }
            };

            buildCloneMaps(moddedWeapons);
            buildCloneMaps(moddedAttachments);
            buildCloneMaps(moddedAmmo);

            for (const ammo of [...allAmmo, ...moddedAmmo]) 
            {
                const caliber = (ammo._props.Caliber || ammo._props.ammoCaliber || "").toLowerCase();
                if (caliber) 
                {
                    if (!caliberToAmmo.has(caliber)) caliberToAmmo.set(caliber, []);
                    caliberToAmmo.get(caliber)!.push(ammo._id);
                }
                else 
                {
                    logMessage("warning", `Ammo ${ammo._id} (${locales[`${ammo._id} Name`] || "Unknown"}): No valid Caliber or ammoCaliber found`, true);
                }
            }

            const weaponsToProcess = passNumber === 1 ? [...moddedWeapons, ...allWeapons] : allWeapons.filter(x => modifiedItems!.has(x._id));
            const slottedItemsToProcess = passNumber === 1 ? [...allWeapons, ...moddedWeapons, ...allAttachments, ...moddedAttachments] : 
                [...allWeapons, ...moddedWeapons, ...allAttachments, ...moddedAttachments].filter(x => modifiedItems!.has(x._id));
            const itemsToProcessForConflicts = passNumber === 1 ? [...itemToBase.entries()] : [...itemToBase.entries()].filter(([moddedId]) => modifiedItems!.has(moddedId));

            const itemSlots = new Map<string, Map<string, string[]>>();
            const validateSlot = (item: Item, slot: Slot, type: string): boolean => 
            {
                if (!slot._name || typeof slot._name !== "string") 
                {
                    logMessage("warning", `Item ${item._id} (${locales[`${item._id} Name`] || "Unknown"}): ${type} slot missing _name or _name is not a string`, true);
                    return false;
                }
                const filter = slot._props?.filters?.[0]?.Filter || [];
                if (!Array.isArray(filter)) 
                {
                    logMessage("warning", `Item ${item._id} (${locales[`${item._id} Name`] || "Unknown"}): ${type} slot ${slot._name} has invalid or missing filters`, true);
                    return false;
                }
                return true;
            };

            for (const item of slottedItemsToProcess) 
            {
                const slotsMap = new Map<string, string[]>();
                for (const type of ["Slots", "Chambers", "Cartridges"]) 
                {
                    const slots = item._props[type] || [];
                    for (const slot of slots) 
                    {
                        if (validateSlot(item, slot, type)) 
                        {
                            slotsMap.set(slot._name.toLowerCase(), slot._props!.filters![0].Filter);
                        }
                    }
                }
                if (config.verboseLogging) 
                {
                    if (slotsMap.size === 0) 
                    {
                        logMessage("debug", `Pass ${passNumber}: No slots found for item ${item._id} (${locales[`${item._id} Name`] || "Unknown"})`, true);
                        if (itemHelper.isOfBaseclass(item._id, BaseClasses.MAGAZINE)) 
                        {
                            logMessage("debug", `Pass ${passNumber}: Cartridges for item ${item._id}: ${JSON.stringify(item._props.Cartridges || [], null, 2)}`, true);
                        }
                        else if (itemHelper.isOfBaseclass(item._id, BaseClasses.WEAPON)) 
                        {
                            logMessage("debug", `Pass ${passNumber}: Chambers for item ${item._id}: ${JSON.stringify(item._props.Chambers || [], null, 2)}`, true);
                        }
                    }
                    else 
                    {
                        logMessage("debug", `Pass ${passNumber}: Slots for item ${item._id} (${locales[`${item._id} Name`] || "Unknown"}): ${Array.from(slotsMap.keys()).join(", ")}`, true);
                    }
                }
                itemSlots.set(item._id, slotsMap);
            }

            const isProprietarySlot = (filter: string[]): boolean => 
                filter.length === 0 || filter.every(id => !items[id]?._props?.Prefab?.path.startsWith("assets/content/"));

            const proprietaryItems = new Set<string>();
            for (const item of slottedItemsToProcess) 
            {
                const slotsMap = itemSlots.get(item._id);
                if (slotsMap) 
                {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    for (const [slotName, filter] of slotsMap) 
                    {
                        if (isProprietarySlot(filter)) 
                        {
                            for (const acceptedId of filter) 
                            {
                                if (!items[acceptedId]?._props?.Prefab?.path.startsWith("assets/content/")) 
                                {
                                    proprietaryItems.add(acceptedId);
                                }
                            }
                        }
                    }
                }
            }

            const nonProprietaryItems = new Set<string>();
            for (const item of slottedItemsToProcess) 
            {
                const slotsMap = itemSlots.get(item._id);
                if (slotsMap) 
                {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    for (const [slotName, filter] of slotsMap) 
                    {
                        if (!isProprietarySlot(filter)) 
                        {
                            for (const acceptedId of filter) 
                            {
                                nonProprietaryItems.add(acceptedId);
                            }
                        }
                    }
                }
            }

            for (const candidate of proprietaryItems) 
            {
                if (nonProprietaryItems.has(candidate)) proprietaryItems.delete(candidate);
            }

            logMessage("debug", `Proprietary items: ${Array.from(proprietaryItems).join(", ")}`, true);

            let numAmmoToChambers = 0;
            let numAmmoToCartridges = 0;
            let numAttachmentsToSlots = 0;
            let numBaseConflictsAdded = 0;
            let numClonedConflictsAdded = 0;
            let numConflictsVoided = 0;
            let numManualAdditions = 0;
            const modifiedItemsThisPass = new Set<string>();

            for (const weapon of weaponsToProcess) 
            {
                if (config.blacklist.includes(weapon._id)) continue;
                const caliber = (weapon._props.ammoCaliber || "").toLowerCase();
                if (caliber && caliberToAmmo.has(caliber)) 
                {
                    const moddedAmmoForCaliber = caliberToAmmo.get(caliber)!.filter(
                        id => !items[id]._props.Prefab?.path.startsWith("assets/content/") && !config.blacklist.includes(id) && !proprietaryItems.has(id)
                    );
                    const chambers = weapon._props.Chambers || [];
                    for (const chamber of chambers) 
                    {
                        if (!validateSlot(weapon, chamber, "Chambers")) continue;
                        const filter = chamber._props!.filters![0].Filter;
                        if (!isProprietarySlot(filter) || config.whitelist.includes(weapon._id)) 
                        {
                            for (const ammoId of moddedAmmoForCaliber) 
                            {
                                if (!filter.includes(ammoId)) 
                                {
                                    filter.push(ammoId);
                                    modifiedItemsThisPass.add(weapon._id);
                                    logMessage("info", `Pass ${passNumber}: Added modded ammo ${ammoId} (${locales[`${ammoId} Name`] || "Unknown"}) to ${weapon._id} (${locales[`${weapon._id} Name`] || "Unknown"}) chamber slot ${chamber._name}`, true);
                                    numAmmoToChambers++;
                                }
                                else 
                                {
                                    logMessage("debug", `Pass ${passNumber}: Skipped adding ammo ${ammoId} (${locales[`${ammoId} Name`] || "Unknown"}) to ${weapon._id} (${locales[`${weapon._id} Name`] || "Unknown"}) chamber slot ${chamber._name}: already exists`, true);
                                }
                            }
                        }
                    }
                }
            }

            const magazinesToProcess = passNumber === 1 ? allAttachments.filter(x => itemHelper.isOfBaseclass(x._id, BaseClasses.MAGAZINE)) : 
                allAttachments.filter(x => itemHelper.isOfBaseclass(x._id, BaseClasses.MAGAZINE) && modifiedItems!.has(x._id));
            for (const magazine of magazinesToProcess) 
            {
                if (config.blacklist.includes(magazine._id)) continue;
                const cartridges = magazine._props.Cartridges || [];
                for (const cartridge of cartridges) 
                {
                    if (!validateSlot(magazine, cartridge, "Cartridges")) continue;
                    const filter = cartridge._props!.filters![0].Filter;
                    if (isProprietarySlot(filter) && !config.whitelist.includes(magazine._id)) continue;
                    const magazineCalibers = new Set<string>();
                    for (const ammoId of filter) 
                    {
                        const ammoCaliber = (items[ammoId]?._props.Caliber || "").toLowerCase();
                        if (ammoCaliber) magazineCalibers.add(ammoCaliber);
                    }
                    for (const magCaliber of magazineCalibers) 
                    {
                        if (caliberToAmmo.has(magCaliber)) 
                        {
                            const moddedAmmoForCaliber = caliberToAmmo.get(magCaliber)!.filter(
                                id => !items[id]._props.Prefab?.path.startsWith("assets/content/") && !config.blacklist.includes(id) && !proprietaryItems.has(id)
                            );
                            for (const ammoId of moddedAmmoForCaliber) 
                            {
                                if (!filter.includes(ammoId)) 
                                {
                                    filter.push(ammoId);
                                    modifiedItemsThisPass.add(magazine._id);
                                    logMessage("info", `Pass ${passNumber}: Added modded ammo ${ammoId} (${locales[`${ammoId} Name`] || "Unknown"}) to ${magazine._id} (${locales[`${magazine._id} Name`] || "Unknown"}) cartridge slot ${cartridge._name}`, true);
                                    numAmmoToCartridges++;
                                }
                                else 
                                {
                                    logMessage("debug", `Pass ${passNumber}: Skipped adding ammo ${ammoId} (${locales[`${ammoId} Name`] || "Unknown"}) to ${magazine._id} (${locales[`${magazine._id} Name`] || "Unknown"}) cartridge slot ${cartridge._name}: already exists`, true);
                                }
                            }
                        }
                    }
                }
            }

            for (const item of slottedItemsToProcess) 
            {
                if (config.blacklist.includes(item._id)) continue;
                const slotsMap = itemSlots.get(item._id);
                if (slotsMap) 
                {
                    for (const [slotName, filter] of slotsMap) 
                    {
                        if (isProprietarySlot(filter) && !config.whitelist.includes(item._id)) continue;
                        const newAttachments: string[] = [];
                        for (const acceptedId of filter) 
                        {
                            if (baseToClones.has(acceptedId)) 
                            {
                                const clones = baseToClones.get(acceptedId)!.filter(id => !config.blacklist.includes(id) && !proprietaryItems.has(id));
                                for (const cloneId of clones) 
                                {
                                    if (!filter.includes(cloneId)) newAttachments.push(cloneId);
                                }
                            }
                        }
                        for (const newAttach of newAttachments) 
                        {
                            filter.push(newAttach);
                            modifiedItemsThisPass.add(item._id);
                            logMessage("info", `Pass ${passNumber}: Added modded attachment ${newAttach} (${locales[`${newAttach} Name`] || "Unknown"}) to ${item._id} (${locales[`${item._id} Name`] || "Unknown"}) slot ${slotName}`, true);
                            numAttachmentsToSlots++;
                        }
                        if (config.verboseLogging && newAttachments.length === 0 && filter.length > 0) 
                        {
                            logMessage("debug", `Pass ${passNumber}: No new attachments added to ${item._id} (${locales[`${item._id} Name`] || "Unknown"}) slot ${slotName}: all compatible items already included`, true);
                        }
                    }
                }
            }

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
                            logMessage("debug", `Pass ${passNumber}: Skipped adding base conflict ${baseConflictId} (${locales[`${baseConflictId} Name`] || "Unknown"}) to modded item ${moddedId} (${locales[`${moddedId} Name`] || "Unknown"}): in VoidConflicts`, true);
                            numConflictsVoided++;
                            continue;
                        }
                        if (!moddedConflicts.includes(baseConflictId)) 
                        {
                            moddedConflicts.push(baseConflictId);
                            modifiedItemsThisPass.add(moddedId);
                            logMessage("info", `Pass ${passNumber}: Added base conflict ${baseConflictId} (${locales[`${baseConflictId} Name`] || "Unknown"}) to modded item ${moddedId} (${locales[`${moddedId} Name`] || "Unknown"})`, true);
                            numBaseConflictsAdded++;
                        }
                        else 
                        {
                            logMessage("debug", `Pass ${passNumber}: Skipped adding base conflict ${baseConflictId} (${locales[`${baseConflictId} Name`] || "Unknown"}) to modded item ${moddedId} (${locales[`${moddedId} Name`] || "Unknown"}): already exists`, true);
                        }
                    }
                }
                else 
                {
                    logMessage("debug", `Pass ${passNumber}: Skipped base conflict inheritance due to inheritBaseConflicts: false`, true);
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
                                    logMessage("debug", `Pass ${passNumber}: Skipped adding cloned conflict ${cloneId} (${locales[`${cloneId} Name`] || "Unknown"}) to modded item ${moddedId} (${locales[`${moddedId} Name`] || "Unknown"}): in VoidConflicts`, true);
                                    numConflictsVoided++;
                                    continue;
                                }
                                if (!moddedConflicts.includes(cloneId)) 
                                {
                                    moddedConflicts.push(cloneId);
                                    modifiedItemsThisPass.add(moddedId);
                                    logMessage("info", `Pass ${passNumber}: Added cloned conflict ${cloneId} (${locales[`${cloneId} Name`] || "Unknown"}) to modded item ${moddedId} (${locales[`${moddedId} Name`] || "Unknown"})`, true);
                                    numClonedConflictsAdded++;
                                }
                                else 
                                {
                                    logMessage("debug", `Pass ${passNumber}: Skipped adding cloned conflict ${cloneId} (${locales[`${cloneId} Name`] || "Unknown"}) to modded item ${moddedId} (${locales[`${moddedId} Name`] || "Unknown"}): already exists`, true);
                                }
                            }
                        }
                    }
                }
                else 
                {
                    logMessage("debug", `Pass ${passNumber}: Skipped cloned conflict inheritance due to inheritCloneConflicts: false`, true);
                }

                items[moddedId]._props.ConflictingItems = moddedConflicts;
            }

            for (const manual of config.ManualAdd || []) 
            {
                const { attachmentId, targetItemId } = manual;
                if (!attachmentId || !targetItemId) 
                {
                    logMessage("warning", `Pass ${passNumber}: Invalid ManualAdd entry: ${JSON.stringify(manual)}`);
                    continue;
                }
                if (!items[attachmentId]) 
                {
                    logMessage("warning", `Pass ${passNumber}: ManualAdd attachmentId ${attachmentId} not found in database`);
                    continue;
                }
                if (!items[targetItemId]) 
                {
                    logMessage("warning", `Pass ${passNumber}: ManualAdd targetItemId ${targetItemId} not found in database`);
                    continue;
                }
                if (!itemHelper.isOfBaseclass(attachmentId, BaseClasses.MOD) && !itemHelper.isOfBaseclass(attachmentId, BaseClasses.AMMO)) 
                {
                    logMessage("warning", `Pass ${passNumber}: ManualAdd attachmentId ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) is neither a mod nor ammo`);
                    continue;
                }
                if (config.blacklist.includes(attachmentId) || config.blacklist.includes(targetItemId)) 
                {
                    logMessage("debug", `Pass ${passNumber}: Skipped ManualAdd ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) to ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}): one or both IDs in blacklist`, true);
                    continue;
                }

                let slotName: string | null = null;
                let targetFilter: string[] | null = null;
                const targetItem = items[targetItemId];

                if (itemHelper.isOfBaseclass(attachmentId, BaseClasses.AMMO)) 
                {
                    if (itemHelper.isOfBaseclass(targetItemId, BaseClasses.WEAPON)) 
                    {
                        const chambers = targetItem._props.Chambers || [];
                        if (chambers.length > 0 && validateSlot(targetItem, chambers[0], "Chambers")) 
                        {
                            slotName = chambers[0]._name;
                            targetFilter = chambers[0]._props!.filters![0].Filter;
                            logMessage("debug", `Pass ${passNumber}: Using Chambers slot ${slotName} for weapon ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"})`, true);
                        }
                        else 
                        {
                            logMessage("warning", `Pass ${passNumber}: Weapon ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}): No valid Chambers defined`);
                            continue;
                        }
                    }
                    else if (itemHelper.isOfBaseclass(targetItemId, BaseClasses.MAGAZINE)) 
                    {
                        const cartridges = targetItem._props.Cartridges || [];
                        if (cartridges.length > 0 && validateSlot(targetItem, cartridges[0], "Cartridges")) 
                        {
                            slotName = cartridges[0]._name;
                            targetFilter = cartridges[0]._props!.filters![0].Filter;
                            logMessage("debug", `Pass ${passNumber}: Using Cartridges slot ${slotName} for magazine ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"})`, true);
                        }
                        else 
                        {
                            logMessage("warning", `Pass ${passNumber}: Magazine ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}): No valid Cartridges defined`);
                            continue;
                        }
                    }
                }
                else 
                {
                    const attachment = items[attachmentId];
                    const commonModTypes = ["mod_foregrip", "mod_sight", "mod_magazine", "mod_muzzle", "mod_stock", "mod_barrel", "mod_handguard"];
                    for (const modType of commonModTypes) 
                    {
                        if (itemHelper.isOfBaseclass(attachmentId, modType)) 
                        {
                            slotName = modType;
                            const targetSlots = itemSlots.get(targetItemId) || new Map<string, string[]>();
                            targetFilter = targetSlots.get(modType.toLowerCase()) || [];
                            break;
                        }
                    }
                    if (!slotName) 
                    {
                        const attachmentSlots = attachment._props.Slots || [];
                        if (attachmentSlots.length > 0 && validateSlot(attachment, attachmentSlots[0], "Slots")) 
                        {
                            slotName = attachmentSlots[0]._name;
                            const targetSlots = itemSlots.get(targetItemId) || new Map<string, string[]>();
                            targetFilter = targetSlots.get(slotName.toLowerCase()) || [];
                        }
                    }
                }

                if (!slotName || !targetFilter) 
                {
                    logMessage("warning", `Pass ${passNumber}: No valid slot found for attachment ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) on target item ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"})`);
                    continue;
                }

                logMessage("debug", `Pass ${passNumber}: Processing ManualAdd ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) to ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}) slot ${slotName}, current filter: [${targetFilter.join(", ")}]`, true);

                if (!targetFilter.includes(attachmentId)) 
                {
                    targetFilter.push(attachmentId);
                    modifiedItemsThisPass.add(targetItemId);
                    logMessage("info", `Pass ${passNumber}: Manually added attachment ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) to ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}) slot ${slotName}`, true);
                    numManualAdditions++;
                }
                else 
                {
                    logMessage("debug", `Pass ${passNumber}: Skipped ManualAdd ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) to ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}) slot ${slotName}: already included in filter [${targetFilter.join(", ")}]`, true);
                }
            }

            if (!config.verboseLogging) 
            {
                logMessage("info", `AutoCompatFramework Pass ${passNumber} Summary:`);
                logMessage("info", `- Added ${numAmmoToChambers} ammo to chambers`);
                logMessage("info", `- Added ${numAmmoToCartridges} ammo to cartridges`);
                logMessage("info", `- Added ${numAttachmentsToSlots} attachments to slots`);
                logMessage("info", `- Added ${numBaseConflictsAdded} base conflicts`);
                logMessage("info", `- Added ${numClonedConflictsAdded} cloned conflicts`);
                logMessage("info", `- Voided ${numConflictsVoided} conflicts`);
                logMessage("info", `- Added ${numManualAdditions} manual additions`);
            }

            if (config.verboseLogging && 
                numAmmoToChambers === 0 && numAmmoToCartridges === 0 && numAttachmentsToSlots === 0 &&
                numBaseConflictsAdded === 0 && numClonedConflictsAdded === 0 && numConflictsVoided === 0 && numManualAdditions === 0) 
            {
                logMessage("debug", `Pass ${passNumber}: No new compatibilities, conflicts, or manual additions added.`, true);
            }

            return {
                numAmmoToChambers,
                numAmmoToCartridges,
                numAttachmentsToSlots,
                numBaseConflictsAdded,
                numClonedConflictsAdded,
                numConflictsVoided,
                numManualAdditions,
                modifiedItems: modifiedItemsThisPass
            };
        };

        const firstPassResult = processCompatibility(1);
        let totalAmmoToChambers = firstPassResult.numAmmoToChambers;
        let totalAmmoToCartridges = firstPassResult.numAmmoToCartridges;
        let totalAttachmentsToSlots = firstPassResult.numAttachmentsToSlots;
        let totalBaseConflictsAdded = firstPassResult.numBaseConflictsAdded;
        let totalClonedConflictsAdded = firstPassResult.numClonedConflictsAdded;
        let totalConflictsVoided = firstPassResult.numConflictsVoided;
        let totalManualAdditions = firstPassResult.numManualAdditions;
        const modifiedItems = firstPassResult.modifiedItems;

        if (config.secondPass && modifiedItems.size > 0) 
        {
            logMessage("debug", `Pass 2: Processing ${modifiedItems.size} modified items`, true);
            const secondPassResult = processCompatibility(2, modifiedItems);
            totalAmmoToChambers += secondPassResult.numAmmoToChambers;
            totalAmmoToCartridges += secondPassResult.numAmmoToCartridges;
            totalAttachmentsToSlots += secondPassResult.numAttachmentsToSlots;
            totalBaseConflictsAdded += secondPassResult.numBaseConflictsAdded;
            totalClonedConflictsAdded += secondPassResult.numClonedConflictsAdded;
            totalConflictsVoided += secondPassResult.numConflictsVoided;
            totalManualAdditions += secondPassResult.numManualAdditions;
        }
        else if (config.verboseLogging) 
        {
            logMessage("debug", `Pass 2: Skipped - secondPass: ${config.secondPass}, modifiedItems: ${modifiedItems.size}`, true);
        }

        if (config.secondPass && !config.verboseLogging) 
        {
            logMessage("info", "AutoCompatFramework Total Summary:");
            logMessage("info", `- Added ${totalAmmoToChambers} ammo to chambers`);
            logMessage("info", `- Added ${totalAmmoToCartridges} ammo to cartridges`);
            logMessage("info", `- Added ${totalAttachmentsToSlots} attachments to slots`);
            logMessage("info", `- Added ${totalBaseConflictsAdded} base conflicts`);
            logMessage("info", `- Added ${totalClonedConflictsAdded} cloned conflicts`);
            logMessage("info", `- Voided ${totalConflictsVoided} conflicts`);
            logMessage("info", `- Added ${totalManualAdditions} manual additions`);
        }

        logMessage("success", "AutoCompatFramework: Mod Cross-compatibility applied successfully.");

        const jokeMessages = [
            { message: "Square peg go in square hole. Round peg go in round hole.", textColor: LogTextColor.CYAN },
            { message: "Is it in yet?", textColor: LogTextColor.CYAN },
            { message: "You guys tryin to put the thing on the thing?... Cool, cool, cool...", textColor: LogTextColor.CYAN },
            { message: "If it fits, it sits.", textColor: LogTextColor.CYAN },
            { message: "If it fits, it ships.", textColor: LogTextColor.CYAN },
            { message: "If it fits, install it.", textColor: LogTextColor.MAGENTA },
            { message: "Wait for applause...", textColor: LogTextColor.CYAN },
            { message: "Now, will it blend?...", textColor: LogTextColor.CYAN },
            { message: "Measure twice, cut once.", textColor: LogTextColor.CYAN },
            { message: "Too many options? Start with a corner piece.", textColor: LogTextColor.CYAN },
            { message: "Keep your options open.", textColor: LogTextColor.CYAN },
            { message: "Be careful, it goes off for, like, NO reason...", textColor: LogTextColor.CYAN },
            { message: "Some motherfuckers are always trying to ice skate uphill...", textColor: LogTextColor.CYAN },
            { message: "PC Load Letter? What the fuck does that mean?...", textColor: LogTextColor.CYAN },
            { message: "If you build it, they will come.", textColor: LogTextColor.CYAN },
            { message: "The whole is greater than the sum of its parts.", textColor: LogTextColor.CYAN },
            { message: "Now we have options - and that's terrifying.", textColor: LogTextColor.CYAN },
            { message: "An escalator can never break: it can only become stairs.", textColor: LogTextColor.CYAN },
            { message: "Don't ever take a fence down until you know why it was put up.", textColor: LogTextColor.CYAN },
            { message: "Perfect is the enemy of good. - Voltaire", textColor: LogTextColor.MAGENTA },
            { message: "I just don't see how having somebody piss on my face is going to help me sell Lou Ferrigno's house...", textColor: LogTextColor.CYAN },
            { message: "When you have eliminated the impossible, whatever remains, however improbable, must be the truth.", textColor: LogTextColor.MAGENTA },
            { message: "Accepting oneself does not preclude an attempt to become better. - Flannery O'Connor", textColor: LogTextColor.CYAN },
            { message: "Do I contradict myself? Very well then I contradict myself, (I am large, I contain multitudes.)", textColor: LogTextColor.CYAN },
            { message: "Why should a man walk around with a pistol and let himself be insulted? It's mighty strange...", textColor: LogTextColor.CYAN },
            { message: "SPT Modders were so preoccupied with whether or not they could, they didn't stop to think if they should.", textColor: LogTextColor.MAGENTA },
            { message: "Now the only limit is your imagination, and my competence", textColor: LogTextColor.MAGENTA },
            { message: "Good design fits - first in logic, then in form. This mod has neither.", textColor: LogTextColor.CYAN },
            { message: "Whole-ass one thing or don’t bother.", textColor: LogTextColor.MAGENTA },
            { message: "Well then, get your shit together. Get it all together. And put it in a backpack. All your shit. So it’s together.", textColor: LogTextColor.MAGENTA }
        ];
        const randomIndex = Math.floor(Math.random() * jokeMessages.length);
        const selectedMessage = jokeMessages[randomIndex];
        logger.logWithColor(selectedMessage.message, selectedMessage.textColor);
    }
}

export const mod = new AutoCompatFramework();
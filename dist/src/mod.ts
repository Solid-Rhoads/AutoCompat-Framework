import path from "node:path";
import fs from "node:fs";
import { DependencyContainer } from "tsyringe";
import { IPostDBLoadMod } from "@spt/models/external/IPostDBLoadMod";
import { DatabaseServer } from "@spt/servers/DatabaseServer";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { FileSystemSync } from "@spt/utils/FileSystemSync";
import { BaseClasses } from "@spt/models/enums/BaseClasses";
import { ItemHelper } from "@spt/helpers/ItemHelper";
import { LogTextColor } from "@spt/models/spt/logging/LogTextColor";
import { jsonc } from "jsonc";
import { PreSptModLoader } from "@spt/loaders/PreSptModLoader";
import { processManualAdd } from "./utils/manualAdd";
import { Item, Slot, ModConfig, PassResult } from "./references/types";
import { normalizeCalibers } from "./helpers/choccyPatch";
import { handleConflicts } from "./helpers/conflictHelper";
import { loadCache, saveCache, findBaseIdFromJson } from "./helpers/modHelper";
import vanillaItems from "./references/vanillaitems.json";

class AutoCompatFramework implements IPostDBLoadMod 
{
    public postDBLoad(container: DependencyContainer): void 
    {
        const logger = container.resolve<ILogger>("WinstonLogger");
        const fileSystem = container.resolve<FileSystemSync>("FileSystemSync");
        const databaseServer = container.resolve<DatabaseServer>("DatabaseServer");
        const itemHelper = container.resolve<ItemHelper>("ItemHelper");
        const preSptModLoader = container.resolve<PreSptModLoader>("PreSptModLoader");

        const colorMap: { [key: string]: LogTextColor } = {
            CYAN: LogTextColor.CYAN,
            MAGENTA: LogTextColor.MAGENTA
        };

        const isLogTextColor = (color: any): color is LogTextColor => 
            Object.values(LogTextColor).includes(color);

        const logMessage = (
            level: "info" | "warning" | "debug" | "success",
            message: string,
            verboseOnly: boolean = false,
            verboseLogging: boolean,
            color?: LogTextColor | string
        ) => 
        {
            if (verboseOnly && !verboseLogging) return;

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
                let resolvedColor: LogTextColor | undefined;
                if (isLogTextColor(color)) 
                {
                    resolvedColor = color;
                }
                else if (typeof color === "string") 
                {
                    resolvedColor = colorMap[color.toUpperCase()];
                }

                if (resolvedColor) 
                {
                    logger.logWithColor(message, resolvedColor);
                }
                else 
                {
                    logger.warning(`Invalid color for message: ${message}, color: ${color}`);
                    logger.info(message);
                }
            }
            else 
            {
                logger.info(message);
            }
        };

        logMessage("info", "AutoCompatibility Framework: Beginning Calculations...", false, false, LogTextColor.CYAN);

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
            logMessage("debug", `Loaded config: ${JSON.stringify(config, null, 2)}`, true, config.verboseLogging);
        }

        const items = databaseServer.getTables().templates.items;
        const locales = databaseServer.getTables().locales.global["en"];

        normalizeCalibers(items, itemHelper, BaseClasses);

        const weaponBaseClasses = [BaseClasses.WEAPON];
        const attachmentBaseClasses = [BaseClasses.MOD, BaseClasses.AMMO];

        const processCompatibility = (): PassResult => 
        {
            const allItems = Object.values(items);
            const allWeapons = allItems.filter(x => weaponBaseClasses.some(base => itemHelper.isOfBaseclass(x._id, base)));
            const allAttachments = allItems.filter(x => attachmentBaseClasses.some(base => itemHelper.isOfBaseclass(x._id, base)));
            const allAmmo = allItems.filter(x => itemHelper.isOfBaseclass(x._id, BaseClasses.AMMO));

            const moddedWeapons = allWeapons.filter(x => !vanillaItems.WEAPON.includes(x._id) || !x._props?.Prefab?.path.startsWith("assets/content/"));
            const moddedAttachments = allAttachments.filter(x => itemHelper.isOfBaseclass(x._id, BaseClasses.MOD) && (!vanillaItems.MOD.includes(x._id) || !x._props?.Prefab?.path.startsWith("assets/content/")));
            const moddedAmmo = allAmmo.filter(x => !vanillaItems.AMMO.includes(x._id) || !x._props?.Prefab?.path.startsWith("assets/content/"));

            if (config.verboseLogging) 
            {
                logMessage("debug", "Excluding ammo from clone mapping, using caliber-based logic for chambers and cartridges", true, config.verboseLogging);
            }

            const itemToBase = new Map<string, string>();
            const baseToClones = new Map<string, string[]>();
            const caliberToAmmo = new Map<string, string[]>();
            const baseIdCache = new Map<string, string>();
            const cachePath = path.resolve(__dirname, "cache", "cache.json");

            let cacheLoaded = false;
            if (config.modFileParsing) 
            {
                cacheLoaded = loadCache(cachePath, baseIdCache, items, config, logMessage);
                if (!cacheLoaded) 
                {
                    logMessage("info", "AutoCompatFramework: Parsing mod files... Please wait.", false, config.verboseLogging);
                }
            }

            const findBaseId = (item: Item, baseIdCache: Map<string, string>, cacheLoaded: boolean): string | null => 
            {
                const name = item._name || item._props?.Name || item._id;

                if (config.modFileParsing && baseIdCache.has(item._id)) 
                {
                    const cachedBaseId = baseIdCache.get(item._id)!;
                    if (items[cachedBaseId]) 
                    {
                        if (config.verboseLogging) 
                        {
                            logMessage("debug", `Cache hit for ${item._id}: ${cachedBaseId}`, true, config.verboseLogging);
                        }
                        return cachedBaseId;
                    }
                    else 
                    {
                        logMessage("warning", `Invalid cache entry for ${item._id}: baseId ${cachedBaseId} not found in items`, true, config.verboseLogging);
                        baseIdCache.delete(item._id);
                    }
                }

                for (const [id, dbItem] of Object.entries(items)) 
                {
                    if ((dbItem._name === name || dbItem._props?.Name === name) && dbItem._props?.Prefab?.path.startsWith("assets/content/")) 
                    {
                        if (id === item._id) 
                        {
                            if (config.verboseLogging) 
                            {
                                logMessage("warning", `Name match for ${item._id} (${locales[`${item._id} Name`] || "Unknown"}) resolved to itself, falling back to JSON parsing`, true, config.verboseLogging);
                            }
                            if (config.modFileParsing && !cacheLoaded) 
                            {
                                const mods = preSptModLoader.getImportedModsNames().filter(mod => mod !== "AutoCompatFramework");
                                const baseId = findBaseIdFromJson(item._id, mods, preSptModLoader, items, baseIdCache, config, logMessage);
                                if (baseId && items[baseId]) 
                                {
                                    return baseId;
                                }
                            }
                            logMessage("warning", `Modded item ${item._id} (${locales[`${item._id} Name`] || "Unknown"}): No base item found for clone mapping`, true, config.verboseLogging);
                            return null;
                        }
                        if (config.verboseLogging) 
                        {
                            logMessage("debug", `Found base item ${id} for ${item._id} via name match`, true, config.verboseLogging);
                        }
                        return id;
                    }
                }

                if (config.modFileParsing && !cacheLoaded) 
                {
                    const mods = preSptModLoader.getImportedModsNames().filter(mod => mod !== "AutoCompatFramework");
                    const baseId = findBaseIdFromJson(item._id, mods, preSptModLoader, items, baseIdCache, config, logMessage);
                    if (baseId && items[baseId]) 
                    {
                        return baseId;
                    }
                    else 
                    {
                        logMessage("warning", `Modded item ${item._id} (${locales[`${item._id} Name`] || "Unknown"}): No base item found for clone mapping`, true, config.verboseLogging);
                        return null;
                    }
                }
                else 
                {
                    if (config.verboseLogging) 
                    {
                        logMessage("debug", `JSON parsing disabled or cache loaded for ${item._id} (${locales[`${item._id} Name`] || "Unknown"}); relying on name-based lookup`, true, config.verboseLogging);
                    }
                    return null;
                }
            };

            const buildCloneMaps = (moddedList: Item[], cacheLoaded: boolean) => 
            {
                for (const moddedItem of moddedList) 
                {
                    const baseId = findBaseId(moddedItem, baseIdCache, cacheLoaded);
                    if (baseId && items[baseId]) 
                    {
                        itemToBase.set(moddedItem._id, baseId);
                        if (!baseToClones.has(baseId)) baseToClones.set(baseId, []);
                        baseToClones.get(baseId)!.push(moddedItem._id);
                    }
                }
            };

            if (config.modFileParsing) 
            {
                buildCloneMaps(moddedWeapons, cacheLoaded);
                buildCloneMaps(moddedAttachments, cacheLoaded);
                saveCache(cachePath, baseIdCache, config, cacheLoaded, logMessage);
            }
            else 
            {
                buildCloneMaps(moddedWeapons, false);
                buildCloneMaps(moddedAttachments, false);
            }

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
                    logMessage("warning", `Ammo ${ammo._id} (${locales[`${ammo._id} Name`] || "Unknown"}): No valid Caliber or ammoCaliber found`, true, config.verboseLogging);
                }
            }

            const weaponsToProcess = moddedWeapons;
            const magazinesToProcess = moddedAttachments.filter(x => itemHelper.isOfBaseclass(x._id, BaseClasses.MAGAZINE));
            const slottedItemsToProcess = [...moddedWeapons, ...moddedAttachments];

            const manualAddTargetIds = new Set<string>(
                config.ManualAdd.flatMap(manual => 
                    Array.isArray(manual.targetItemIds) ? manual.targetItemIds : [manual.targetItemIds]
                )
            );
            const itemsToProcessForSlots = [
                ...slottedItemsToProcess,
                ...allItems.filter(x => config.whitelist.includes(x._id) || manualAddTargetIds.has(x._id))
            ];
            const itemsToProcessForConflicts = [...itemToBase.entries()].filter(([moddedId, baseId]) => items[moddedId] && items[baseId]);

            const itemSlots = new Map<string, Map<string, string[]>>();
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

            for (const item of itemsToProcessForSlots) 
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
                        logMessage("debug", `No slots found for item ${item._id} (${locales[`${item._id} Name`] || "Unknown"})`, true, config.verboseLogging);
                        if (itemHelper.isOfBaseclass(item._id, BaseClasses.MAGAZINE)) 
                        {
                            logMessage("debug", `Cartridges for item ${item._id}: ${JSON.stringify(item._props.Cartridges || [], null, 2)}`, true, config.verboseLogging);
                        }
                        else if (itemHelper.isOfBaseclass(item._id, BaseClasses.WEAPON)) 
                        {
                            logMessage("debug", `Chambers for item ${item._id}: ${JSON.stringify(item._props.Chambers || [], null, 2)}`, true, config.verboseLogging);
                        }
                    }
                    else 
                    {
                        logMessage("debug", `Slots for item ${item._id} (${locales[`${item._id} Name`] || "Unknown"}): ${Array.from(slotsMap.keys()).join(", ")}`, true, config.verboseLogging);
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
                    for (const [slotName, filter] of slotsMap) 
                    {
                        if (slotName.includes("mod_") && isProprietarySlot(filter)) 
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
                    for (const [slotName, filter] of slotsMap) 
                    {
                        if (slotName.includes("mod_") && !isProprietarySlot(filter)) 
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

            logMessage("debug", `Proprietary items: ${Array.from(proprietaryItems).join(", ")}`, true, config.verboseLogging);

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
                        for (const ammoId of moddedAmmoForCaliber) 
                        {
                            if (!filter.includes(ammoId)) 
                            {
                                filter.push(ammoId);
                                modifiedItemsThisPass.add(weapon._id);
                                logMessage("info", `Added modded ammo ${ammoId} (${locales[`${ammoId} Name`] || "Unknown"}) to ${weapon._id} (${locales[`${weapon._id} Name`] || "Unknown"}) chamber slot ${chamber._name}`, true, config.verboseLogging);
                                numAmmoToChambers++;
                            }
                            else 
                            {
                                logMessage("debug", `Skipped adding ammo ${ammoId} (${locales[`${ammoId} Name`] || "Unknown"}) to ${weapon._id} (${locales[`${weapon._id} Name`] || "Unknown"}) chamber slot ${chamber._name}: already exists`, true, config.verboseLogging);
                            }
                        }
                    }
                }
            }

            for (const magazine of magazinesToProcess) 
            {
                if (config.blacklist.includes(magazine._id)) continue;
                const cartridges = magazine._props.Cartridges || [];
                for (const cartridge of cartridges) 
                {
                    if (!validateSlot(magazine, cartridge, "Cartridges")) continue;
                    const filter = cartridge._props!.filters![0].Filter;
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
                                    logMessage("info", `Added modded ammo ${ammoId} (${locales[`${ammoId} Name`] || "Unknown"}) to ${magazine._id} (${locales[`${magazine._id} Name`] || "Unknown"}) cartridge slot ${cartridge._name}`, true, config.verboseLogging);
                                    numAmmoToCartridges++;
                                }
                                else 
                                {
                                    logMessage("debug", `Skipped adding ammo ${ammoId} (${locales[`${ammoId} Name`] || "Unknown"}) to ${magazine._id} (${locales[`${magazine._id} Name`] || "Unknown"}) cartridge slot ${cartridge._name}: already exists`, true, config.verboseLogging);
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
                            logMessage("info", `Added modded attachment ${newAttach} (${locales[`${newAttach} Name`] || "Unknown"}) to ${item._id} (${locales[`${newAttach} Name`] || "Unknown"}) slot ${slotName}`, true, config.verboseLogging);
                            numAttachmentsToSlots++;
                        }
                        if (config.verboseLogging && newAttachments.length === 0 && filter.length > 0) 
                        {
                            logMessage("debug", `No new attachments added to ${item._id} (${locales[`${item._id} Name`] || "Unknown"}) slot ${slotName}: all compatible items already included`, true, config.verboseLogging);
                        }
                    }
                }
            }

            const conflictResults = handleConflicts(
                items,
                config,
                baseToClones,
                locales,
                logMessage,
                itemsToProcessForConflicts,
                modifiedItemsThisPass,
                numBaseConflictsAdded,
                numClonedConflictsAdded,
                numConflictsVoided
            );
            numBaseConflictsAdded = conflictResults.numBaseConflictsAdded;
            numClonedConflictsAdded = conflictResults.numClonedConflictsAdded;
            numConflictsVoided = conflictResults.numConflictsVoided;

            numManualAdditions = processManualAdd(
                config,
                items,
                itemSlots,
                itemHelper,
                locales,
                logMessage,
                itemToBase,
                allItems,
                1,
                modifiedItemsThisPass,
                numManualAdditions
            );

            if (!config.verboseLogging) 
            {
                logMessage("info", "AutoCompatFramework Summary:", false, config.verboseLogging);
                logMessage("info", `- Added ${numAmmoToChambers} ammo to chambers`, false, config.verboseLogging);
                logMessage("info", `- Added ${numAmmoToCartridges} ammo to cartridges`, false, config.verboseLogging);
                logMessage("info", `- Added ${numAttachmentsToSlots} attachments to slots`, false, config.verboseLogging);
                logMessage("info", `- Added ${numBaseConflictsAdded} base conflicts`, false, config.verboseLogging);
                logMessage("info", `- Added ${numClonedConflictsAdded} cloned conflicts`, false, config.verboseLogging);
                logMessage("info", `- Voided ${numConflictsVoided} conflicts`, false, config.verboseLogging);
                logMessage("info", `- Added ${numManualAdditions} manual additions`, false, config.verboseLogging);
            }

            if (config.verboseLogging && 
                numAmmoToChambers === 0 && numAmmoToCartridges == 0 && numAttachmentsToSlots == 0 &&
                numBaseConflictsAdded == 0 && numClonedConflictsAdded == 0 && numConflictsVoided == 0 && numManualAdditions == 0) 
            {
                logMessage("debug", "No new compatibilities, conflicts, or manual additions added.", true, config.verboseLogging);
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

        processCompatibility();

        logMessage("success", "AutoCompatFramework: Mod Cross-compatibility applied successfully.", false, config.verboseLogging);

        let logMessages: Array<{ message: string; textColor: string }>;
        try 
        {
            const content = fs.readFileSync(path.resolve(__dirname, "./utils/logMessages.json"), "utf8");
            logMessages = jsonc.parse(content);
        }
        catch (error) 
        {
            logger.error(`AutoCompatFramework: Failed to load logMessages.json: ${error.message}`);
            return;
        }

        const randomIndex = Math.floor(Math.random() * logMessages.length);
        const selectedMessage = logMessages[randomIndex];
        logMessage("info", selectedMessage.message, false, config.verboseLogging, selectedMessage.textColor);
    }
}

export const mod = new AutoCompatFramework();
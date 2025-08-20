import { DependencyContainer } from "tsyringe";
import { IPostDBLoadMod } from "@spt/models/external/IPostDBLoadMod";
import { DatabaseServer } from "@spt/servers/DatabaseServer";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { BaseClasses } from "@spt/models/enums/BaseClasses";
import { ItemHelper } from "@spt/helpers/ItemHelper";
import modConfig from "../config/config.json";

class AutoCompatFramework implements IPostDBLoadMod
{
    public postDBLoad(container: DependencyContainer): void
    {
        if (!modConfig.enabled) 
        {
            return;
        }

        const logger = container.resolve<ILogger>("WinstonLogger");
        const databaseServer = container.resolve<DatabaseServer>("DatabaseServer");
        const itemHelper = container.resolve<ItemHelper>("ItemHelper");

        // Get duh fuggin tables
        const tables = databaseServer.getTables();
        const items = tables.templates.items;
        const locales = tables.locales.global["en"]; // Probably best to use english locale for reference

        // Define base classes
        const weaponBaseClasses = [
            BaseClasses.WEAPON
        ];
        const attachmentBaseClasses = [
            BaseClasses.MOD
        ];

        // Process compatibility logic for a single pass
        const processCompatibility = (passNumber: number, modifiedItems?: Set<string>) => 
        {
            // Compute modded weapons, attachments, and ammo
            const databaseItems = Object.values(items);
            const allWeapons = databaseItems.filter(x => weaponBaseClasses.some(baseClass => itemHelper.isOfBaseclass(x._id, baseClass)));
            const allAttachments = databaseItems.filter(x => attachmentBaseClasses.some(baseClass => itemHelper.isOfBaseclass(x._id, baseClass)));
            const allAmmo = databaseItems.filter(x => itemHelper.isOfBaseclass(x._id, BaseClasses.AMMO));

            const moddedWeapons = allWeapons.filter(x => 
            {
                const prefabPath = x._props?.Prefab?.path || "";
                return !prefabPath.startsWith("assets/content/");
            });
            const moddedAttachments = allAttachments.filter(x => 
            {
                const prefabPath = x._props?.Prefab?.path || "";
                return !prefabPath.startsWith("assets/content/");
            });
            const moddedAmmo = allAmmo.filter(x => 
            {
                const prefabPath = x._props?.Prefab?.path || "";
                return !prefabPath.startsWith("assets/content/");
            });

            // Maps for clone relationships: moddedId => baseId
            const itemToBase = new Map<string, string>();
            // Base to modded clones: baseId => [moddedIds]
            const baseToClones = new Map<string, string[]>();
            // Caliber to ammo IDs: caliber => [ammoIds] (base and modded)
            const caliberToAmmo = new Map<string, string[]>();

            // Determine base ID by _name matching
            const findBaseIdByName = (name: string) => 
            {
                for (const [id, item] of Object.entries(items)) 
                {
                    if (item._name === name && (item._props?.Prefab?.path || "").startsWith("assets/content/")) 
                    {
                        return id;
                    }
                }
                return null;
            };

            // Build clone maps for weapons, attachments, ammo
            const buildCloneMaps = (moddedList: any[]) => 
            {
                for (const moddedItem of moddedList) 
                {
                    const baseId = findBaseIdByName(moddedItem._name);
                    if (baseId) 
                    {
                        itemToBase.set(moddedItem._id, baseId);
                        if (!baseToClones.has(baseId)) 
                        {
                            baseToClones.set(baseId, []);
                        }
                        baseToClones.get(baseId)!.push(moddedItem._id);
                    }
                }
            };

            buildCloneMaps(moddedWeapons);
            buildCloneMaps(moddedAttachments);
            buildCloneMaps(moddedAmmo);

            // Build caliber to ammo map (base + modded)
            const allAmmoItems = [...allAmmo, ...moddedAmmo];
            for (const ammo of allAmmoItems) 
            {
                const caliber = ammo._props.Caliber || ammo._props.ammoCaliber;
                if (caliber) 
                {
                    if (!caliberToAmmo.has(caliber)) 
                    {
                        caliberToAmmo.set(caliber, []);
                    }
                    caliberToAmmo.get(caliber)!.push(ammo._id);
                }
            }

            // Filter items for second pass if modifiedItems is provided
            const weaponsToProcess = passNumber === 1 ? [...moddedWeapons, ...allWeapons] : [...moddedWeapons, ...allWeapons].filter(x => modifiedItems!.has(x._id));
            const slottedItemsToProcess = passNumber === 1 ? [...allWeapons, ...moddedWeapons, ...allAttachments, ...moddedAttachments] : [...allWeapons, ...moddedWeapons, ...allAttachments, ...moddedAttachments].filter(x => modifiedItems!.has(x._id));
            const itemsToProcessForConflicts = passNumber === 1 ? [...itemToBase.entries()] : [...itemToBase.entries()].filter(([moddedId]) => modifiedItems!.has(moddedId));

            // Weapon/attachment ID to its slots map: itemId => {slotName: filterIds[]}
            const itemSlots = new Map<string, Map<string, string[]>>();

            // Build item slots map for weapons and attachments (base + modded)
            for (const item of slottedItemsToProcess) 
            {
                const slotsMap = new Map<string, string[]>();
                const slotTypes = ["Slots", "Chambers", "Cartridges"];
                for (const type of slotTypes) 
                {
                    const slots = item._props[type] || [];
                    for (const slot of slots) 
                    {
                        const slotName = slot._name;
                        const filter = slot._props.filters?.[0]?.Filter || [];
                        slotsMap.set(slotName, filter);
                    }
                }
                itemSlots.set(item._id, slotsMap);
            }

            // Check if a slot is proprietary (only accepts modded IDs or empty)
            const isProprietarySlot = (filter: string[]) => 
            {
                return filter.length === 0 || filter.every(id => 
                {
                    const prefabPath = items[id]?._props?.Prefab?.path || "";
                    return !prefabPath.startsWith("assets/content/");
                });
            };

            // Identify proprietary slots and collect candidates for proprietary attachments
            const proprietaryAttachments = new Set<string>();
            for (const item of slottedItemsToProcess) 
            {
                const slotsMap = itemSlots.get(item._id);
                if (slotsMap) 
                {
                    // wow this actually works eslint be weird
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    for (const [_slotName, filter] of slotsMap.entries()) 
                    {
                        if (isProprietarySlot(filter)) 
                        {
                            for (const acceptedId of filter) 
                            {
                                const prefabPath = items[acceptedId]?._props?.Prefab?.path || "";
                                if (!prefabPath.startsWith("assets/content/")) 
                                {
                                    proprietaryAttachments.add(acceptedId);
                                }
                            }
                        }
                    }
                }
            }

            // Check if these candidates are accepted in any non-proprietary slot
            const nonProprietaryAttachments = new Set<string>();
            for (const item of slottedItemsToProcess) 
            {
                const slotsMap = itemSlots.get(item._id);
                if (slotsMap) 
                {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    for (const [_slotName, filter] of slotsMap.entries()) 
                    {
                        if (!isProprietarySlot(filter)) 
                        {
                            for (const acceptedId of filter) 
                            {
                                nonProprietaryAttachments.add(acceptedId);
                            }
                        }
                    }
                }
            }

            // del proprietary attachment candidates not in non-proprietary slots
            for (const candidate of proprietaryAttachments) 
            {
                if (nonProprietaryAttachments.has(candidate)) 
                {
                    proprietaryAttachments.delete(candidate);
                }
            }

            // Debug log for proprietary attachments
            if (modConfig.verboseLogging) 
            {
                logger.debug(`Proprietary attachments: ${Array.from(proprietaryAttachments).join(", ")}`);
            }

            // Counters for summary logging
            let numAmmoToChambers = 0;
            let numAmmoToCartridges = 0;
            let numAttachmentsToSlots = 0;
            let numBaseConflictsAdded = 0;
            let numClonedConflictsAdded = 0;
            let numConflictsVoided = 0;
            let numManualAdditions = 0;

            // Track modified items in this pass
            const passModifiedItems = new Set<string>();

            // Apply compatibility
            // Add modded ammo to chambers/cartridges of weapons/mags if caliber matches and not proprietary
            for (const weapon of weaponsToProcess) 
            {
                if (modConfig.blacklist.includes(weapon._id)) continue;
                const caliber = weapon._props.ammoCaliber;
                if (caliber && caliberToAmmo.has(caliber)) 
                {
                    const moddedAmmoForCaliber = caliberToAmmo.get(caliber)!.filter(ammoId => 
                    {
                        const prefabPath = items[ammoId]?._props?.Prefab?.path || "";
                        return !prefabPath.startsWith("assets/content/") && !modConfig.blacklist.includes(ammoId) && !proprietaryAttachments.has(ammoId);
                    });
                    const chambers = weapon._props.Chambers || [];
                    for (const chamber of chambers) 
                    {
                        const filter = chamber._props.filters?.[0]?.Filter || [];
                        const isProprietary = isProprietarySlot(filter) && !modConfig.whitelist.includes(weapon._id);
                        if (!isProprietary) 
                        {
                            for (const ammoId of moddedAmmoForCaliber) 
                            {
                                if (!filter.includes(ammoId)) 
                                {
                                    filter.push(ammoId);
                                    passModifiedItems.add(weapon._id);
                                    if (modConfig.verboseLogging) 
                                    {
                                        logger.info(`Pass ${passNumber}: Added modded ammo ${ammoId} (${locales[`${ammoId} Name`] || "Unknown"}) to ${weapon._id} (${locales[`${weapon._id} Name`] || "Unknown"}) chamber`);
                                    }
                                    numAmmoToChambers++;
                                } 
                                else if (modConfig.verboseLogging) 
                                {
                                    logger.debug(`Pass ${passNumber}: Skipped adding ammo ${ammoId} (${locales[`${ammoId} Name`] || "Unknown"}) to ${weapon._id} (${locales[`${weapon._id} Name`] || "Unknown"}) chamber: already exists`);
                                }
                            }
                        }
                    }
                    // Same for cartridges in magazines
                    if (itemHelper.isOfBaseclass(weapon._id, BaseClasses.MAGAZINE)) 
                    {
                        const cartridges = weapon._props.Cartridges || [];
                        for (const cartridge of cartridges) 
                        {
                            const filter = cartridge._props.filters?.[0]?.Filter || [];
                            const isProprietary = isProprietarySlot(filter) && !modConfig.whitelist.includes(weapon._id);
                            if (!isProprietary) 
                            {
                                for (const ammoId of moddedAmmoForCaliber) 
                                {
                                    if (!filter.includes(ammoId)) 
                                    {
                                        filter.push(ammoId);
                                        passModifiedItems.add(weapon._id);
                                        if (modConfig.verboseLogging) 
                                        {
                                            logger.info(`Pass ${passNumber}: Added modded ammo ${ammoId} (${locales[`${ammoId} Name`] || "Unknown"}) to ${weapon._id} (${locales[`${weapon._id} Name`] || "Unknown"}) cartridge`);
                                        }
                                        numAmmoToCartridges++;
                                    } 
                                    else if (modConfig.verboseLogging) 
                                    {
                                        logger.debug(`Pass ${passNumber}: Skipped adding ammo ${ammoId} (${locales[`${ammoId} Name`] || "Unknown"}) to ${weapon._id} (${locales[`${weapon._id} Name`] || "Unknown"}) cartridge: already exists`);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Add modded attachments to slots if the slot accepts the base attachment and not proprietary
            for (const slottedItem of slottedItemsToProcess) 
            {
                if (modConfig.blacklist.includes(slottedItem._id)) continue;
                const slotsMap = itemSlots.get(slottedItem._id);
                if (slotsMap) 
                {
                    for (const [slotName, filter] of slotsMap.entries()) 
                    {
                        const isProprietary = isProprietarySlot(filter) && !modConfig.whitelist.includes(slottedItem._id);
                        if (isProprietary) continue;
                        const newAttachments = [];
                        for (const acceptedId of [...filter]) 
                        {
                            if (baseToClones.has(acceptedId)) 
                            {
                                const clones = baseToClones.get(acceptedId)!.filter(cloneId => !modConfig.blacklist.includes(cloneId) && !proprietaryAttachments.has(cloneId));
                                for (const cloneId of clones) 
                                {
                                    if (!filter.includes(cloneId)) 
                                    {
                                        newAttachments.push(cloneId);
                                    }
                                }
                            }
                        }
                        for (const newAttach of newAttachments) 
                        {
                            filter.push(newAttach);
                            passModifiedItems.add(slottedItem._id);
                            if (modConfig.verboseLogging) 
                            {
                                logger.info(`Pass ${passNumber}: Added modded attachment ${newAttach} (${locales[`${newAttach} Name`] || "Unknown"}) to ${slottedItem._id} (${locales[`${slottedItem._id} Name`] || "Unknown"}) slot ${slotName}`);
                            }
                            numAttachmentsToSlots++;
                        }
                        if (modConfig.verboseLogging && newAttachments.length === 0 && filter.length > 0) 
                        {
                            logger.debug(`Pass ${passNumber}: No new attachments added to ${slottedItem._id} (${locales[`${slottedItem._id} Name`] || "Unknown"}) slot ${slotName}: all compatible items already included`);
                        }
                    }
                }
            }

            // Propagate conflicting items from base to clones
            for (const [moddedId, baseId] of itemsToProcessForConflicts) 
            {
                if (modConfig.blacklist.includes(moddedId)) continue;
                const baseConflicts = items[baseId]._props.ConflictingItems || [];
                const moddedConflicts = items[moddedId]._props.ConflictingItems || [];

                // Inherit base conflicts
                if (modConfig.inheritBaseConflicts)
                {
                    for (const baseConflictId of baseConflicts) 
                    {
                        if (modConfig.VoidConflicts.includes(baseConflictId)) 
                        {
                            if (modConfig.verboseLogging) 
                            {
                                logger.debug(`Pass ${passNumber}: Skipped adding base conflict ${baseConflictId} (${locales[`${baseConflictId} Name`] || "Unknown"}) to modded item ${moddedId} (${locales[`${moddedId} Name`] || "Unknown"}): in VoidConflicts`);
                            }
                            numConflictsVoided++;
                            continue;
                        }
                        if (!moddedConflicts.includes(baseConflictId)) 
                        {
                            moddedConflicts.push(baseConflictId);
                            passModifiedItems.add(moddedId);
                            if (modConfig.verboseLogging) 
                            {
                                logger.info(`Pass ${passNumber}: Added base conflict ${baseConflictId} (${locales[`${baseConflictId} Name`] || "Unknown"}) to modded item ${moddedId} (${locales[`${moddedId} Name`] || "Unknown"})`);
                            }
                            numBaseConflictsAdded++;
                        } 
                        else if (modConfig.verboseLogging) 
                        {
                            logger.debug(`Pass ${passNumber}: Skipped adding base conflict ${baseConflictId} (${locales[`${baseConflictId} Name`] || "Unknown"}) to modded item ${moddedId} (${locales[`${moddedId} Name`] || "Unknown"}): already exists`);
                        }
                    }
                }
                else if (modConfig.verboseLogging)
                {
                    logger.debug(`Pass ${passNumber}: Skipped base conflict inheritance due to inheritBaseConflicts: false`);
                }

                // Inherit cloned conflicts
                if (modConfig.inheritCloneConflicts)
                {
                    for (const baseConflictId of baseConflicts) 
                    {
                        if (baseToClones.has(baseConflictId)) 
                        {
                            const clones = baseToClones.get(baseConflictId)!.filter(cloneId => !modConfig.blacklist.includes(cloneId));
                            for (const cloneId of clones) 
                            {
                                if (modConfig.VoidConflicts.includes(cloneId)) 
                                {
                                    if (modConfig.verboseLogging) 
                                    {
                                        logger.debug(`Pass ${passNumber}: Skipped adding cloned conflict ${cloneId} (${locales[`${cloneId} Name`] || "Unknown"}) to modded item ${moddedId} (${locales[`${moddedId} Name`] || "Unknown"}): in VoidConflicts`);
                                    }
                                    numConflictsVoided++;
                                    continue;
                                }
                                if (!moddedConflicts.includes(cloneId)) 
                                {
                                    moddedConflicts.push(cloneId);
                                    passModifiedItems.add(moddedId);
                                    if (modConfig.verboseLogging) 
                                    {
                                        logger.info(`Pass ${passNumber}: Added cloned conflict ${cloneId} (${locales[`${cloneId} Name`] || "Unknown"}) to modded item ${moddedId} (${locales[`${moddedId} Name`] || "Unknown"})`);
                                    }
                                    numClonedConflictsAdded++;
                                } 
                                else if (modConfig.verboseLogging) 
                                {
                                    logger.debug(`Pass ${passNumber}: Skipped adding cloned conflict ${cloneId} (${locales[`${cloneId} Name`] || "Unknown"}) to modded item ${moddedId} (${locales[`${moddedId} Name`] || "Unknown"}): already exists`);
                                }
                            }
                        }
                    }
                }
                else if (modConfig.verboseLogging)
                {
                    logger.debug(`Pass ${passNumber}: Skipped cloned conflict inheritance due to inheritCloneConflicts: false`);
                }

                items[moddedId]._props.ConflictingItems = moddedConflicts;
            }

            // Process ManualAdd entries
            for (const manual of modConfig.ManualAdd || []) 
            {
                const { attachmentId, targetItemId } = manual;
                if (!attachmentId || !targetItemId) 
                {
                    logger.warning(`Pass ${passNumber}: Invalid ManualAdd entry: ${JSON.stringify(manual)}`);
                    continue;
                }
                if (!items[attachmentId]) 
                {
                    logger.warning(`Pass ${passNumber}: ManualAdd attachmentId ${attachmentId} not found in database`);
                    continue;
                }
                if (!items[targetItemId]) 
                {
                    logger.warning(`Pass ${passNumber}: ManualAdd targetItemId ${targetItemId} not found in database`);
                    continue;
                }
                if (!itemHelper.isOfBaseclass(attachmentId, BaseClasses.MOD)) 
                {
                    logger.warning(`Pass ${passNumber}: ManualAdd attachmentId ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) is not a mod`);
                    continue;
                }
                if (modConfig.blacklist.includes(attachmentId) || modConfig.blacklist.includes(targetItemId)) 
                {
                    if (modConfig.verboseLogging) 
                    {
                        logger.debug(`Pass ${passNumber}: Skipped ManualAdd ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) to ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}): one or both IDs in blacklist`);
                    }
                    continue;
                }

                // Determine mod type (slot name) of attachment
                let modType: string | null = null;
                const attachment = items[attachmentId];
                const attachmentSlots = attachment._props.Slots || [];
                if (attachmentSlots.length > 0) 
                {
                    modType = attachmentSlots[0]._name; // Use first slot name if available
                } 
                else 
                {
                    // Fallback to checking parent class or common mod types
                    const commonModTypes = ["mod_foregrip", "mod_sight", "mod_magazine", "mod_muzzle", "mod_stock", "mod_barrel", "mod_handguard"];
                    for (const slotType of commonModTypes) 
                    {
                        if (itemHelper.isOfBaseclass(attachmentId, slotType)) 
                        {
                            modType = slotType;
                            break;
                        }
                    }
                }
                if (!modType) 
                {
                    logger.warning(`Pass ${passNumber}: Could not determine mod type for attachment ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"})`);
                    continue;
                }

                // Find matching slot on target item
                const targetSlots = itemSlots.get(targetItemId) || new Map<string, string[]>();
                const targetFilter = targetSlots.get(modType);
                if (!targetFilter) 
                {
                    logger.warning(`Pass ${passNumber}: Target item ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}) has no slot for ${modType}`);
                    continue;
                }

                // Check proprietary status
                const isProprietary = isProprietarySlot(targetFilter) && !modConfig.whitelist.includes(targetItemId);
                if (isProprietary) 
                {
                    if (modConfig.verboseLogging) 
                    {
                        logger.debug(`Pass ${passNumber}: Skipped ManualAdd ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) to ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}) slot ${modType}: proprietary slot`);
                    }
                    continue;
                }

                // Add attachment to slot filter if not already present
                if (!targetFilter.includes(attachmentId)) 
                {
                    targetFilter.push(attachmentId);
                    passModifiedItems.add(targetItemId);
                    if (modConfig.verboseLogging) 
                    {
                        logger.info(`Pass ${passNumber}: Manually added attachment ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) to ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}) slot ${modType}`);
                    }
                    numManualAdditions++;
                } 
                else if (modConfig.verboseLogging) 
                {
                    logger.debug(`Pass ${passNumber}: Skipped ManualAdd ${attachmentId} (${locales[`${attachmentId} Name`] || "Unknown"}) to ${targetItemId} (${locales[`${targetItemId} Name`] || "Unknown"}) slot ${modType}: already exists`);
                }
            }

            // Log summaries for this pass if not verbose
            if (!modConfig.verboseLogging) 
            {
                logger.info(`AutoCompatFramework Pass ${passNumber} Summary:`);
                logger.info(`- Added ${numAmmoToChambers} ammo to chambers`);
                logger.info(`- Added ${numAmmoToCartridges} ammo to cartridges`);
                logger.info(`- Added ${numAttachmentsToSlots} attachments to slots`);
                logger.info(`- Added ${numBaseConflictsAdded} base conflicts`);
                logger.info(`- Added ${numClonedConflictsAdded} cloned conflicts`);
                logger.info(`- Voided ${numConflictsVoided} conflicts`);
                logger.info(`- Added ${numManualAdditions} manual additions`);
            }

            // Log if no changes were made in this pass
            if (modConfig.verboseLogging && numAmmoToChambers === 0 && numAmmoToCartridges === 0 && numAttachmentsToSlots === 0 && numBaseConflictsAdded === 0 && numClonedConflictsAdded === 0 && numConflictsVoided === 0 && numManualAdditions === 0) 
            {
                logger.debug(`Pass ${passNumber}: No new compatibilities, conflicts, or manual additions added.`);
            }

            return { numAmmoToChambers, numAmmoToCartridges, numAttachmentsToSlots, numBaseConflictsAdded, numClonedConflictsAdded, numConflictsVoided, numManualAdditions, passModifiedItems };
        };

        // First pass
        const firstPassResult = processCompatibility(1);
        let totalAmmoToChambers = firstPassResult.numAmmoToChambers;
        let totalAmmoToCartridges = firstPassResult.numAmmoToCartridges;
        let totalAttachmentsToSlots = firstPassResult.numAttachmentsToSlots;
        let totalBaseConflictsAdded = firstPassResult.numBaseConflictsAdded;
        let totalClonedConflictsAdded = firstPassResult.numClonedConflictsAdded;
        let totalConflictsVoided = firstPassResult.numConflictsVoided;
        let totalManualAdditions = firstPassResult.numManualAdditions;
        const modifiedItems = firstPassResult.passModifiedItems;

        // Second pass if enabled and modifications were made
        if (modConfig.secondPass && modifiedItems.size > 0) 
        {
            if (modConfig.verboseLogging) 
            {
                logger.debug(`Pass 2: Processing ${modifiedItems.size} modified items`);
            }
            const secondPassResult = processCompatibility(2, modifiedItems);
            totalAmmoToChambers += secondPassResult.numAmmoToChambers;
            totalAmmoToCartridges += secondPassResult.numAmmoToCartridges;
            totalAttachmentsToSlots += secondPassResult.numAttachmentsToSlots;
            totalBaseConflictsAdded += secondPassResult.numBaseConflictsAdded;
            totalClonedConflictsAdded += secondPassResult.numClonedConflictsAdded;
            totalConflictsVoided += secondPassResult.numConflictsVoided;
            totalManualAdditions += secondPassResult.numManualAdditions;
        } 
        else if (modConfig.verboseLogging) 
        {
            logger.debug(`Pass 2: Skipped - secondPass: ${modConfig.secondPass}, modifiedItems: ${modifiedItems.size}`);
        }

        // Log total summary if second pass was run and not verbose
        if (modConfig.secondPass && !modConfig.verboseLogging) 
        {
            logger.info("AutoCompatFramework Total Summary:");
            logger.info(`- Added ${totalAmmoToChambers} ammo to chambers`);
            logger.info(`- Added ${totalAmmoToCartridges} ammo to cartridges`);
            logger.info(`- Added ${totalAttachmentsToSlots} attachments to slots`);
            logger.info(`- Added ${totalBaseConflictsAdded} base conflicts`);
            logger.info(`- Added ${totalClonedConflictsAdded} cloned conflicts`);
            logger.info(`- Voided ${totalConflictsVoided} conflicts`);
            logger.info(`- Added ${totalManualAdditions} manual additions`);
        }

        logger.success("AutoCompatFramework: Mod Cross-compatibility applied successfully.");
    }
}

export const mod = new AutoCompatFramework();
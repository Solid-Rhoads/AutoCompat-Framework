import path from "node:path";
import fs from "node:fs";
import { PreSptModLoader } from "@spt/loaders/PreSptModLoader";
import { ITemplateItem } from "@spt/models/eft/common/tables/ITemplateItem";
import { jsonc } from "jsonc";
import { LogTextColor } from "@spt/models/spt/logging/LogTextColor";
import { ModConfig } from "../references/types";

export const loadCache = (
    cachePath: string,
    baseIdCache: Map<string, string>,
    items: Record<string, ITemplateItem>,
    config: ModConfig,
    logMessage: (level: "info" | "warning" | "debug" | "success", message: string, verboseOnly?: boolean, verboseLogging?: boolean, color?: LogTextColor | string) => void
): boolean => 
{
    try 
    {
        if (!fs.existsSync(cachePath)) 
        {
            if (config.modFileParsing) 
            {
                logMessage("info", "Cache file not found, will generate new cache", false, config.verboseLogging);
            }
            return false;
        }

        const content = fs.readFileSync(cachePath, "utf8");
        const cacheData = jsonc.parse(content);

        if (typeof cacheData !== "object" || cacheData === null) 
        {
            if (config.modFileParsing) 
            {
                logMessage("warning", "Invalid cache file format, ignoring cache", false, config.verboseLogging);
            }
            return false;
        }

        for (const [moddedId, baseId] of Object.entries(cacheData)) 
        {
            if (typeof moddedId === "string" && typeof baseId === "string" && items[baseId]) 
            {
                baseIdCache.set(moddedId, baseId);
            }
            else if (config.modFileParsing) 
            {
                logMessage("info", `Skipping invalid cache entry: ${moddedId} -> ${baseId}`, false, config.verboseLogging);
            }
        }

        if (config.modFileParsing) 
        {
            logMessage("success", `Cache found: Loaded ${baseIdCache.size} entries from cache`, false, config.verboseLogging);
            logMessage("warning", "Delete cache folder from user/mods/autocompatframework/src if you update or add new weapon, attachment, or ammo mods to allow the cache to regenerate.", false, config.verboseLogging);
        }
        return true;
    }
    catch (error) 
    {
        if (config.modFileParsing) 
        {
            logMessage("warning", `Failed to load cache: ${error.message}`, false, config.verboseLogging);
        }
        return false;
    }
};

export const saveCache = (
    cachePath: string,
    baseIdCache: Map<string, string>,
    config: ModConfig,
    cacheLoaded: boolean,
    logMessage: (level: "info" | "warning" | "debug" | "success", message: string, verboseOnly?: boolean, verboseLogging?: boolean, color?: LogTextColor | string) => void
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
) => 
{
    if (cacheLoaded) 
    {
        return;
    }

    try 
    {
        const cacheDir = path.dirname(cachePath);
        fs.mkdirSync(cacheDir, { recursive: true });
        const cacheObject = Object.fromEntries(baseIdCache);
        fs.writeFileSync(cachePath, jsonc.stringify(cacheObject, null, 2));
        if (config.modFileParsing) 
        {
            logMessage("success", `Saved ${baseIdCache.size} entries to cache`, false, config.verboseLogging);
        }
    }
    catch (error) 
    {
        if (config.modFileParsing) 
        {
            logMessage("warning", `Failed to save cache: ${error.message}`, false, config.verboseLogging);
        }
    }
};

export const getAllJsonFiles = (
    dir: string,
    logMessage: (level: "info" | "warning" | "debug" | "success", message: string, verboseOnly?: boolean, verboseLogging?: boolean, color?: LogTextColor | string) => void,
    config: ModConfig
): string[] => 
{
    let results: string[] = [];
    try 
    {
        const list = fs.readdirSync(dir);
        if (config.verboseLogging) 
        {
            logMessage("debug", `Scanning directory ${dir}: found ${list.length} items`, true, config.verboseLogging);
        }
        list.forEach((file) => 
        {
            const fullPath = path.resolve(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat && stat.isDirectory()) 
            {
                results = results.concat(getAllJsonFiles(fullPath, logMessage, config));
            } 
            else if ((fullPath.endsWith(".json") || fullPath.endsWith(".jsonc")) && !fullPath.includes("tsconfig.json")) 
            {
                results.push(fullPath);
            }
        });
    } 
    catch (error) 
    {
        logMessage("warning", `AutoCompatFramework: Error scanning directory ${dir}: ${error.message}`, false, config.verboseLogging);
    }
    return results;
};

export const findBaseIdFromJson = (
    itemId: string,
    mods: string[],
    preSptModLoader: PreSptModLoader,
    items: Record<string, ITemplateItem>,
    baseIdCache: Map<string, string>,
    config: ModConfig,
    logMessage: (level: "info" | "warning" | "debug" | "success", message: string, verboseOnly?: boolean, verboseLogging?: boolean, color?: LogTextColor | string) => void,
    visited: Set<string> = new Set()
): string | null => 
{
    if (visited.has(itemId)) 
    {
        logMessage("warning", `Circular clone reference detected for ${itemId}`, true, config.verboseLogging);
        return null;
    }
    visited.add(itemId);

    const findEntry = (data: any): any | null => 
    {
        if (typeof data === "object" && data !== null) 
        {
            if (data._id === itemId) 
            {
                return data;
            }
            for (const value of Object.values(data)) 
            {
                const result = findEntry(value);
                if (result) return result;
            }
        }
        return null;
    };

    for (const modName of mods) 
    {
        const modPath = preSptModLoader.getModPath(modName);
        const jsonFiles = getAllJsonFiles(modPath, logMessage, config);

        for (const filePath of jsonFiles) 
        {
            try 
            {
                const content = fs.readFileSync(filePath, "utf8");
                let data;
                try 
                {
                    data = jsonc.parse(content);
                } 
                catch (parseError) 
                {
                    logMessage("warning", `Failed to parse ${filePath} for ${itemId}: ${parseError.message}`, true, config.verboseLogging);
                    continue;
                }

                let entry: any = null;
                let source: string = "none";

                // Try direct lookup for flat JSON structures
                if (typeof data === "object" && data !== null && data[itemId]) 
                {
                    entry = data[itemId];
                    source = "direct";
                }
                // Fall back to recursive search for nested JSON
                else 
                {
                    entry = findEntry(data);
                    if (entry) source = "recursive";
                }

                if (entry) 
                {
                    const cloneId = entry.clone || entry.itemTplToClone || entry._orig || entry._original;
                    if (config.verboseLogging) 
                    {
                        logMessage("debug", `Found ${itemId} in ${filePath} via ${source} lookup, clone: ${cloneId || "none"}`, true, config.verboseLogging);
                    }

                    if (!cloneId) 
                    {
                        logMessage("warning", `No clone, itemTplToClone, _orig, or _original for ${itemId} in ${filePath}`, true, config.verboseLogging);
                        return null;
                    }

                    const cloneItem = items[cloneId];
                    if (cloneItem && cloneItem._props?.Prefab?.path.startsWith("assets/content/")) 
                    {
                        baseIdCache.set(itemId, cloneId);
                        if (config.verboseLogging) 
                        {
                            logMessage("debug", `Resolved ${itemId} to vanilla base ${cloneId} in ${filePath} via ${source} lookup`, true, config.verboseLogging);
                        }
                        return cloneId;
                    } 
                    else 
                    {
                        const baseId = findBaseIdFromJson(cloneId, mods, preSptModLoader, items, baseIdCache, config, logMessage, visited);
                        if (baseId && items[baseId]) 
                        {
                            baseIdCache.set(itemId, baseId);
                            if (config.verboseLogging) 
                            {
                                logMessage("debug", `Resolved ${itemId} to base ${baseId} via chain in ${filePath} from ${source} lookup`, true, config.verboseLogging);
                            }
                            return baseId;
                        }
                    }
                }
            } 
            catch (error) 
            {
                logMessage("warning", `Error processing ${filePath} for ${itemId}: ${error.message}`, true, config.verboseLogging);
            }
        }
    }

    logMessage("warning", `No base item found for ${itemId} in JSON files`, true, config.verboseLogging);
    return null;
};
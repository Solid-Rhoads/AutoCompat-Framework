import { Item } from "../references/types";
import { ItemHelper } from "@spt/helpers/ItemHelper";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { BaseClasses } from "@spt/models/enums/BaseClasses";

export function normalizeCalibers(
    items: Record<string, Item>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    itemHelper: ItemHelper,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    baseClasses: any
): void 
{
    for (const itemId in items) 
    {
        const item = items[itemId];
        if (item._props?.Caliber) 
        {
            item._props.Caliber = item._props.Caliber.replace(/mm/gi, "");
        }
        if (item._props?.ammoCaliber) 
        {
            item._props.ammoCaliber = item._props.ammoCaliber.replace(/mm/gi, "");
        }
    }
}
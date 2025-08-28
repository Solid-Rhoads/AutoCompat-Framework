export interface Item 
{
    _id: string;
    _name?: string;
    _parent?: string;
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

export interface Slot 
{
    _name: string;
    _props?: { filters?: Array<{ Filter: string[] }> };
}

export interface ModConfig 
{
    enabled: boolean;
    verboseLogging: boolean;
    blacklist: string[];
    whitelist: string[];
    VoidConflicts: string[];
    inheritBaseConflicts: boolean;
    inheritCloneConflicts: boolean;
    modFileParsing: boolean;
    ManualAdd: Array<{ attachmentIds: string | string[]; targetItemIds: string | string[] }>;
}

export interface PassResult 
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
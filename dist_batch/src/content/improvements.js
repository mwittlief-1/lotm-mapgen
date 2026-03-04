export const IMPROVEMENTS = {
    granary_upgrade: {
        id: "granary_upgrade",
        name: "Granary Upgrade",
        coin_cost: 6,
        energy_cost: 2,
        required: 40,
        description: "Reduces spoilage meaningfully."
    },
    drainage_ditches: {
        id: "drainage_ditches",
        name: "Drainage & Ditches",
        coin_cost: 8,
        energy_cost: 2,
        required: 60,
        description: "Softens bad weather and stabilizes yields."
    },
    mill_efficiency: {
        id: "mill_efficiency",
        name: "Mill Efficiency",
        coin_cost: 10,
        energy_cost: 3,
        required: 80,
        description: "Slightly improves bushel-to-coin conversion when selling."
    },
    watch_ward: {
        id: "watch_ward",
        name: "Watch & Ward",
        coin_cost: 7,
        energy_cost: 2,
        required: 55,
        description: "Reduces banditry and petty theft."
    },
    field_rotation: {
        id: "field_rotation",
        name: "Field Rotation",
        coin_cost: 5,
        energy_cost: 2,
        required: 45,
        description: "Improves yields and reduces blight pressure."
    },
    physician: {
        id: "physician",
        name: "Physician/Chirurgeon",
        coin_cost: 9,
        energy_cost: 2,
        required: 75,
        description: "Reduces mortality and disease pressure."
    },
    village_feast: {
        id: "village_feast",
        name: "Village Feast/Alms",
        coin_cost: 4,
        energy_cost: 1,
        required: 20,
        description: "Reduces unrest when completed."
    },
    retinue_drills: {
        id: "retinue_drills",
        name: "Retinue Drills",
        coin_cost: 6,
        energy_cost: 2,
        required: 60,
        description: "Improves preparedness (minor reductions to some security events)."
    }
};
export const IMPROVEMENT_IDS = Object.keys(IMPROVEMENTS);
export function hasImprovement(improvements, id) {
    return improvements.includes(id);
}

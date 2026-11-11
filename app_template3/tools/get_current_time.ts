export async function get_current_time() {
    const currentTime = new Date();
    return currentTime.toISOString();
}
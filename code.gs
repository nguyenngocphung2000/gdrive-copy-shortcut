// Hàm tiếp nhận yêu cầu và tạo job
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var sourceUrl = data.sourceUrl;
    var destUrl = data.destUrl || "";
    
    var sourceId = extractId(sourceUrl);
    var destFolderId = destUrl ? extractId(destUrl) : DriveApp.getRootFolder().getId();
    var isFolder = sourceUrl.indexOf('folders') !== -1;
    
    var itemName = "";
    var queue = []; 
    
    if (isFolder) {
       var sourceFolder = DriveApp.getFolderById(sourceId);
       itemName = sourceFolder.getName();
       var destFolder = DriveApp.getFolderById(destFolderId);
       var newFolder = destFolder.createFolder(itemName);
       queue.push({ type: 'folder_init', srcId: sourceId, destId: newFolder.getId() });
    } else {
       var file = DriveApp.getFileById(sourceId);
       itemName = file.getName();
       queue.push({ type: 'file', srcId: sourceId, destId: destFolderId });
    }
    
    var state = {
      queue: queue,
      stats: { files: 0, folders: (isFolder ? 1 : 0), errors: 0 },
      itemName: itemName,
      email: Session.getEffectiveUser().getEmail()
    };
    
    var jobId = 'job_' + Date.now();
    var props = PropertiesService.getScriptProperties();
    props.setProperty(jobId, JSON.stringify(state));
    
    var triggers = ScriptApp.getProjectTriggers();
    if (triggers.length === 0) {
      ScriptApp.newTrigger('processQueue').timeBased().after(1).create();
    }
             
    return ContentService.createTextOutput("Yêu cầu đã được đưa vào hàng đợi. Hệ thống đang tự động xử lý.");
  } catch (err) {
    return ContentService.createTextOutput("Lỗi khởi tạo: " + err.message + ". Có thể thư mục này chặn quyền sao chép.");
  }
}

// Hàm xử lý HTTP GET để chặn lỗi từ Phím tắt iOS
function doGet(e) {
  return ContentService.createTextOutput("Hệ thống tiếp nhận đang hoạt động bình thường.");
}

// Hàm quét và xử lý tuần tự toàn bộ đơn hàng
function processQueue() {
  var startTime = Date.now();
  var MAX_TIME = 300000; 
  var props = PropertiesService.getScriptProperties();
  
  while (true) {
    var allProps = props.getProperties();
    var jobKeys = Object.keys(allProps).filter(function(k) { return k.indexOf('job_') === 0; });
    
    if (jobKeys.length === 0) {
      deleteTriggers();
      return;
    }
    
    var key = jobKeys[0]; 
    var state = JSON.parse(allProps[key]);
    var queue = state.queue;
    var stats = state.stats;
    
    try {
      while (queue.length > 0) {
        if (Date.now() - startTime > MAX_TIME) {
          props.setProperty(key, JSON.stringify(state));
          deleteTriggers();
          ScriptApp.newTrigger('processQueue').timeBased().after(1000).create();
          return; 
        }
        
        var current = queue.shift(); 
        
        if (current.type === 'file') {
           try {
             var file = DriveApp.getFileById(current.srcId);
             var dest = DriveApp.getFolderById(current.destId);
             file.makeCopy(file.getName(), dest);
             stats.files++;
           } catch (e) {
             stats.errors++;
           }
        } 
        else if (current.type === 'folder_init') {
           try {
             var srcFolder = DriveApp.getFolderById(current.srcId);
             var files = srcFolder.getFiles();
             if (files.hasNext()) {
               queue.push({ type: 'files_token', token: files.getContinuationToken(), destId: current.destId });
             }
             var subFolders = srcFolder.getFolders();
             if (subFolders.hasNext()) {
               queue.push({ type: 'folders_token', token: subFolders.getContinuationToken(), destId: current.destId });
             }
           } catch (e) {
             stats.errors++;
           }
        }
        else if (current.type === 'files_token') {
           try {
             var filesIter = DriveApp.continueFileIterator(current.token);
             var destFolder = DriveApp.getFolderById(current.destId);
             var count = 0;
             while (filesIter.hasNext() && count < 30) {
               try {
                 var f = filesIter.next();
                 f.makeCopy(f.getName(), destFolder);
                 stats.files++;
               } catch (fileErr) {
                 stats.errors++;
               }
               count++;
               if (Date.now() - startTime > MAX_TIME) break;
             }
             if (filesIter.hasNext()) {
               queue.unshift({ type: 'files_token', token: filesIter.getContinuationToken(), destId: current.destId });
             }
           } catch (e) {
             stats.errors++;
           }
        }
        else if (current.type === 'folders_token') {
           try {
             var foldersIter = DriveApp.continueFolderIterator(current.token);
             var destFolder = DriveApp.getFolderById(current.destId);
             var count = 0;
             while (foldersIter.hasNext() && count < 10) {
               try {
                 var subF = foldersIter.next();
                 var newSub = destFolder.createFolder(subF.getName());
                 stats.folders++;
                 queue.push({ type: 'folder_init', srcId: subF.getId(), destId: newSub.getId() });
               } catch (folderErr) {
                 stats.errors++;
               }
               count++;
               if (Date.now() - startTime > MAX_TIME) break;
             }
             if (foldersIter.hasNext()) {
               queue.unshift({ type: 'folders_token', token: foldersIter.getContinuationToken(), destId: current.destId });
             }
           } catch (e) {
             stats.errors++;
           }
        }
      }
      
      var emailBody = "Quá trình sao chép dữ liệu đã hoàn tất.\n\n" +
                      "Tên dữ liệu: " + state.itemName + "\n" +
                      "Tổng số thư mục thành công: " + stats.folders + "\n" +
                      "Tổng số tệp thành công: " + stats.files + "\n" +
                      "Số lượng mục bị lỗi/chặn quyền: " + (stats.errors || 0);
                      
      MailApp.sendEmail(state.email, "Hoàn tất sao chép: " + state.itemName, emailBody);
        
      props.deleteProperty(key);
      
    } catch (err) {
      MailApp.sendEmail(state.email, "Lỗi khi sao chép: " + state.itemName, "Tiến trình bị sập: " + err.message);
      props.deleteProperty(key); 
    }
  }
}

// Hàm hỗ trợ xóa các trigger cũ để dọn dẹp hệ thống
function deleteTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }
}

// Hàm hỗ trợ trích xuất ID từ đường dẫn Google Drive
function extractId(url) {
  var match = url.match(/[-\w]{25,}/);
  if (match) return match[0];
  throw new Error("ID không hợp lệ.");
}
